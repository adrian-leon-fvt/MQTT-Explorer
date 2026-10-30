import { expect } from 'chai'
import { EventEmitter } from 'events'
import { describe, it } from 'mocha'
import { org } from 'sparkplug-payload/lib/sparkplugPayloadProto'
import { Base64Message } from '../../../backend/src/Model/Base64Message'
import { Decoder } from '../../../backend/src/Model/Decoder'
import { Tree } from '../../../backend/src/Model/Tree'
import { EventBusInterface, makeConnectionMessageEvent, MqttMessage } from '../../../events'
import { SparkplugDecoder, SparkplugSession } from './SparkplugBDecoder'

const { Payload, DataType } = org.eclipse.tahu.protobuf
type WirePayload = org.eclipse.tahu.protobuf.IPayload
type DisplayPayload = {
  timestamp?: string
  seq?: string
  metrics: Array<Record<string, unknown>>
  sparkplug: { status: string; warnings: string[] }
}

function message(type: string, payload: WirePayload, node = 'node', device?: string): MqttMessage {
  return {
    topic: `spBv1.0/group/${type}/${node}${device ? `/${device}` : ''}`,
    payload: Base64Message.fromBuffer(Buffer.from(Payload.encode(payload).finish())),
    qos: 0,
    retain: false,
    messageId: undefined,
  }
}

function read(incoming: MqttMessage): DisplayPayload {
  expect(incoming.payload).to.be.instanceOf(Base64Message)
  const result = SparkplugDecoder.decode(newPayload(incoming), undefined)
  expect(result.message, result.error).not.to.eq(undefined)
  return JSON.parse(result.message!.toUnicodeString())
}

function newPayload(incoming: MqttMessage): Base64Message {
  if (!(incoming.payload instanceof Base64Message)) throw new Error('Expected captured payload')
  return incoming.payload
}

const birth = (name = 'Temperature'): WirePayload => ({
  metrics: [
    {
      name,
      alias: 0,
      datatype: DataType.Double,
      doubleValue: 20,
    },
    { name: 'bdSeq', datatype: DataType.UInt64, longValue: 1 },
  ],
})
const data: WirePayload = { metrics: [{ alias: 0, doubleValue: 21.5 }] }

describe('Sparkplug B decoding', () => {
  it('resolves alias zero and omitted datatypes from birth while preserving wire bytes', () => {
    const session = new SparkplugSession()
    session.observe(message('NBIRTH', birth()))
    const incoming = message('NDATA', data)
    const bytes = incoming.payload?.base64Message
    session.observe(incoming)
    expect(incoming.payload?.base64Message).to.eq(bytes)
    expect(read(incoming).metrics[0]).to.include({
      name: 'Temperature',
      type: 'Double',
      value: 21.5,
      alias: '0',
    })
    expect(read(incoming).sparkplug.status).to.eq('online')
    expect(read(incoming).sparkplug.warnings).to.deep.eq([])
  })

  it('keeps node, device, group and broker alias scopes separate', () => {
    const session = new SparkplugSession()
    session.observe(message('NBIRTH', birth('Node')))
    session.observe(message('DBIRTH', birth('Device'), 'node', 'device'))
    session.observe(message('NBIRTH', birth('Other node'), 'other'))
    const nodeData = message('NDATA', data)
    const otherNodeData = message('NDATA', data, 'other')
    const deviceData = message('DDATA', data, 'node', 'device')
    session.observe(nodeData)
    session.observe(otherNodeData)
    session.observe(deviceData)
    expect(read(nodeData).metrics[0].name).to.eq('Node')
    expect(read(otherNodeData).metrics[0].name).to.eq('Other node')
    expect(read(deviceData).metrics[0].name).to.eq('Device')
    const otherGroup = message('NDATA', data)
    otherGroup.topic = otherGroup.topic.replace('/group/', '/other/')
    session.observe(otherGroup)
    expect(read(otherGroup).metrics[0].name).to.eq(undefined)
    const otherBroker = message('NDATA', data)
    new SparkplugSession().observe(otherBroker)
    expect(read(otherBroker).sparkplug.warnings.join(' ')).to.include('Missing NBIRTH')
  })

  it('does not rewrite history after rebirth or reconnect', () => {
    const session = new SparkplugSession()
    session.observe(message('NBIRTH', birth('Old')))
    const old = message('NDATA', data)
    session.observe(old)
    session.observe(message('NBIRTH', birth('New')))
    const current = message('NDATA', data)
    session.observe(current)
    expect(read(old).metrics[0].name).to.eq('Old')
    expect(read(current).metrics[0].name).to.eq('New')
    session.reset()
    const afterReconnect = message('NDATA', data)
    session.observe(afterReconnect)
    expect(read(afterReconnect).metrics[0].name).to.eq(undefined)
    expect(read(old).metrics[0].name).to.eq('Old')
  })

  it('invalidates devices on node rebirth/death and only one device on device death', () => {
    const session = new SparkplugSession()
    session.observe(message('NBIRTH', birth()))
    session.observe(message('DBIRTH', birth('A'), 'node', 'a'))
    session.observe(message('DBIRTH', birth('B'), 'node', 'b'))
    const death = message('DDEATH', {}, 'node', 'a')
    session.observe(death)
    expect(read(death).sparkplug.status).to.eq('offline')
    const deviceA = message('DDATA', data, 'node', 'a')
    const deviceB = message('DDATA', data, 'node', 'b')
    session.observe(deviceA)
    session.observe(deviceB)
    expect(read(deviceA).metrics[0].name).to.eq(undefined)
    expect(read(deviceB).metrics[0].name).to.eq('B')
    session.observe(message('NBIRTH', birth()))
    const afterRebirth = message('DDATA', data, 'node', 'b')
    session.observe(afterRebirth)
    expect(read(afterRebirth).sparkplug.warnings.join(' ')).to.include('Missing DBIRTH')
    const nodeDeath = message('NDEATH', { metrics: [{ name: 'bdSeq', datatype: DataType.UInt64, longValue: 1 }] })
    session.observe(nodeDeath)
    expect(read(nodeDeath).sparkplug.status).to.eq('offline')
    const afterDeath = message('NDATA', data)
    session.observe(afterDeath)
    expect(read(afterDeath).metrics[0].name).to.eq(undefined)
  })

  it('ignores stale node deaths from an older bdSeq', () => {
    const session = new SparkplugSession()
    session.observe(message('NBIRTH', birth()))
    const death = message('NDEATH', { metrics: [{ name: 'bdSeq', datatype: DataType.UInt64, longValue: 0 }] })
    session.observe(death)
    expect(read(death).sparkplug.warnings.join(' ')).to.include('Stale NDEATH')
    const incoming = message('NDATA', data)
    session.observe(incoming)
    expect(read(incoming).metrics[0].name).to.eq('Temperature')
  })

  it('resolves command aliases and named metrics with omitted types without learning from data', () => {
    const session = new SparkplugSession()
    session.observe(message('NBIRTH', birth()))
    const command = message('NCMD', data)
    session.observe(command)
    expect(read(command).metrics[0].name).to.eq('Temperature')
    const named = message('NDATA', { metrics: [{ name: 'Temperature', doubleValue: 23 }] })
    session.observe(named)
    expect(read(named).metrics[0]).to.include({ type: 'Double', value: 23 })
    const unknown = message('NDATA', {
      metrics: [
        {
          name: 'Invented',
          alias: 42,
          datatype: DataType.Int32,
          intValue: 1,
        },
      ],
    })
    session.observe(unknown)
    const later = message('NDATA', { metrics: [{ alias: 42, intValue: 2 }] })
    session.observe(later)
    expect(read(later).metrics[0].name).to.eq(undefined)
    expect(read(later).sparkplug.warnings.join(' ')).to.include('Unresolved alias 42')
    expect(read(later).metrics[0].intValue).to.eq(2)
  })

  it('preserves 64-bit precision, signed values, UInt32, nulls and metric flags', () => {
    const incoming = message(
      'NBIRTH',
      Payload.fromObject({
        timestamp: '18446744073709551615',
        seq: 255,
        metrics: [
          { name: 'Signed8', datatype: DataType.Int8, intValue: 255 },
          { name: 'Signed16', datatype: DataType.Int16, intValue: 65535 },
          { name: 'Signed32', datatype: DataType.Int32, intValue: 4294967295 },
          { name: 'Signed64', datatype: DataType.Int64, longValue: '18446744073709551615' },
          { name: 'Unsigned32', datatype: DataType.UInt32, intValue: 4294967295 },
          { name: 'Unsigned64', datatype: DataType.UInt64, longValue: '18446744073709551615' },
          {
            name: 'Null',
            datatype: DataType.Boolean,
            isNull: true,
            isHistorical: true,
            isTransient: true,
          },
        ],
      })
    )
    new SparkplugSession().observe(incoming)
    const decoded = read(incoming)
    expect(decoded.timestamp).to.eq('18446744073709551615')
    expect(decoded.seq).to.eq('255')
    expect(decoded.metrics.map(metric => metric.value)).to.deep.eq([
      -1,
      -1,
      -1,
      '-1',
      4294967295,
      '18446744073709551615',
      null,
    ])
    expect(decoded.metrics[6]).to.include({ isNull: true, isHistorical: true, isTransient: true })
  })

  it('decodes datasets, nested template aliases and binary values without dropping metadata', () => {
    const incoming = message('NBIRTH', {
      metrics: [
        {
          name: 'Table',
          datatype: DataType.DataSet,
          datasetValue: {
            numOfColumns: 2,
            columns: ['x', 'y'],
            types: [DataType.Int32, DataType.String],
            rows: [{ elements: [{ intValue: 4294967295 }, { stringValue: 'hello' }] }],
          },
        },
        {
          name: 'Template',
          alias: 1,
          datatype: DataType.Template,
          templateValue: {
            metrics: [
              {
                name: 'Nested',
                alias: 7,
                datatype: DataType.Float,
                floatValue: 1,
              },
            ],
          },
        },
        {
          name: 'Bytes',
          datatype: DataType.Bytes,
          bytesValue: Buffer.from([0, 255]),
          metadata: { description: 'binary' },
        },
      ],
    })
    const session = new SparkplugSession()
    session.observe(incoming)
    const decoded = read(incoming)
    expect(decoded.metrics[0].value).to.include({ numOfColumns: '2' })
    expect(decoded.metrics[0].value)
      .to.have.property('rows')
      .that.deep.equals([[-1, 'hello']])
    expect(decoded.metrics[2]).to.include({ value: 'AP8=' })
    expect(decoded.metrics[2].metadata).to.deep.eq({ description: 'binary' })
    const update = message('NDATA', {
      metrics: [{ alias: 1, templateValue: { metrics: [{ alias: 7, floatValue: 2 }] } }],
    })
    session.observe(update)
    expect(read(update).metrics[0].value).to.have.property('metrics').that.is.an('array')
    const nested = read(update).metrics[0].value as { metrics: Array<Record<string, unknown>> }
    expect(nested.metrics[0]).to.include({ name: 'Nested', type: 'Float', value: 2 })
  })

  it('reports unsupported types and malformed payloads instead of silently inventing values', () => {
    const session = new SparkplugSession()
    const unsupported = message('NBIRTH', {
      metrics: [{ name: 'Array', datatype: DataType.Int8Array, bytesValue: Buffer.from([1, 2]) }],
    })
    session.observe(unsupported)
    expect(read(unsupported).sparkplug.warnings.join(' ')).to.include('Unsupported datatype')
    expect(read(unsupported).metrics[0].bytesValue).to.eq('AQI=')
    session.observe(message('NBIRTH', birth()))
    const malformed = message('NBIRTH', {})
    malformed.payload = Base64Message.fromBuffer(Buffer.from([0x12, 0xff]))
    session.observe(malformed)
    const result = SparkplugDecoder.decode(newPayload(malformed), undefined)
    expect(result.decoder).to.eq(Decoder.NONE)
    expect(result.error).to.include('Failed to decode')
    expect(result.message?.base64Message).to.eq(malformed.payload.base64Message)
    const after = message('NDATA', data)
    session.observe(after)
    expect(read(after).metrics[0].name).to.eq(undefined)
    const compressed = message('NBIRTH', { uuid: 'SPBV1.0_COMPRESSED', body: Buffer.from([1, 2]) })
    session.observe(compressed)
    expect(SparkplugDecoder.decode(newPayload(compressed), undefined).error).to.include('Compressed')
  })

  it('rejects ambiguous birth aliases and does not fabricate missing scalar values', () => {
    const session = new SparkplugSession()
    const ambiguous = message('NBIRTH', {
      metrics: [
        { name: 'First', alias: 0, datatype: DataType.Double, doubleValue: 1 },
        { name: 'Second', alias: 0, datatype: DataType.Double, doubleValue: 2 },
        { name: 'Missing', datatype: DataType.Int8 },
        { name: 'Not finite', datatype: DataType.Float, floatValue: Number.NaN },
      ],
    })
    session.observe(ambiguous)
    expect(read(ambiguous).sparkplug.warnings.join(' ')).to.include('Duplicate alias 0')
    expect(read(ambiguous).metrics[2].value).to.eq(undefined)
    expect(read(ambiguous).metrics[3].value).to.eq('NaN')
    const incoming = message('NDATA', data)
    session.observe(incoming)
    expect(read(incoming).metrics[0].name).to.eq(undefined)
    expect(read(incoming).sparkplug.warnings.join(' ')).to.include('Unresolved alias 0')
  })

  it('leaves ordinary MQTT and invalid Sparkplug topic shapes untouched', () => {
    const session = new SparkplugSession()
    const topics = ['sensors/a', 'spBv1.0/group/NDATA/node/device', 'spBv1.0/group/DDATA/node']
    topics.forEach(topic => {
      const incoming = { ...message('NDATA', data), topic }
      const original = incoming.payload
      session.observe(incoming)
      expect(incoming.payload).to.eq(original)
      expect(SparkplugDecoder.canDecodeTopic?.(topic)).to.eq(false)
    })
  })

  it('captures on ingress while paused and preserves snapshots through tree/history merging', () => {
    const emitter = new EventEmitter()
    const bus: EventBusInterface = {
      subscribe: (event, callback) => {
        emitter.on(event.topic, callback)
      },
      unsubscribe: (event, callback) => {
        emitter.off(event.topic, callback)
      },
      unsubscribeAll: event => {
        emitter.removeAllListeners(event.topic)
      },
      emit: (event, value) => {
        emitter.emit(event.topic, value)
      },
    }
    const tree = new Tree()
    const session = new SparkplugSession()
    tree.onMessageReceived.subscribe(incoming => session.observe(incoming))
    tree.updateWithConnection(bus, 'test')
    tree.pause()
    try {
      bus.emit(makeConnectionMessageEvent('test'), message('NBIRTH', birth('Before reconnect')))
      const old = message('NDATA', data)
      bus.emit(makeConnectionMessageEvent('test'), old)
      session.reset()
      bus.emit(makeConnectionMessageEvent('test'), message('NBIRTH', birth('After reconnect')))
      const current = message('NDATA', data)
      bus.emit(makeConnectionMessageEvent('test'), current)
      tree.applyUnmergedChanges()
      const node = tree.findNode(current.topic)
      const history = node?.messageHistory.toArray() ?? []
      expect(history).to.have.length(2)
      expect(history[0].payload).to.eq(old.payload)
      expect(history[1].payload).to.eq(current.payload)
      expect(SparkplugDecoder.decode(history[0].payload!, undefined).message?.toUnicodeString()).to.include(
        'Before reconnect'
      )
      expect(SparkplugDecoder.decode(history[1].payload!, undefined).message?.toUnicodeString()).to.include(
        'After reconnect'
      )
    } finally {
      tree.destroy()
    }
  })
})
