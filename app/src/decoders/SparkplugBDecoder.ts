import { org } from 'sparkplug-payload/lib/sparkplugPayloadProto'
import { Base64Message } from '../../../backend/src/Model/Base64Message'
import { Decoder } from '../../../backend/src/Model/Decoder'
import { MqttMessage } from '../../../events'
import { DecoderEnvelope } from './DecoderEnvelope'
import { MessageDecoder } from './MessageDecoder'

const { Payload, DataType } = org.eclipse.tahu.protobuf
type Metric = org.eclipse.tahu.protobuf.Payload.IMetric
type Definitions = { names: Map<string, Metric | undefined>; aliases: Map<string, Metric | undefined> }
type NodeBirth = { metrics?: Definitions; devices: Map<string, Definitions>; bdSeq?: string }
const snapshots = new WeakMap<Base64Message, DecoderEnvelope>()
const jsonOptions = { longs: String, bytes: String, json: true }
const topicPattern =
  /^spBv1\.0\/([^/]+)\/(N(?:BIRTH|DATA|DEATH|CMD)|D(?:BIRTH|DATA|DEATH|CMD))\/([^/]+)(?:\/([^/]+))?$/u

function parseTopic(topic: string) {
  const match = topic.match(topicPattern)
  if (!match || match[2].startsWith('D') !== (match[4] !== undefined)) return undefined
  const [, groupId, messageType, edgeNodeId, deviceId] = match
  return {
    groupId,
    messageType,
    edgeNodeId,
    deviceId,
    nodeKey: `${groupId}/${edgeNodeId}`,
  }
}

function metricAlias(metric: Metric): string | undefined {
  return Object.prototype.hasOwnProperty.call(metric, 'alias') ? metric.alias?.toString() : undefined
}

function definitions(metrics: Metric[], warnings: Set<string>): Definitions {
  const names = new Map<string, Metric | undefined>()
  const aliases = new Map<string, Metric | undefined>()
  metrics.forEach(metric => {
    if (metric.name) {
      if (names.has(metric.name)) {
        warnings.add(`Duplicate metric name ${metric.name} in birth; mapping discarded.`)
        names.set(metric.name, undefined)
      } else {
        names.set(metric.name, metric)
      }
      const alias = metricAlias(metric)
      if (alias !== undefined) {
        if (aliases.has(alias)) {
          warnings.add(`Duplicate alias ${alias} in birth; mapping discarded.`)
          aliases.set(alias, undefined)
        } else {
          aliases.set(alias, metric)
        }
      }
    }
  })
  return { names, aliases }
}

function signedValue(value: unknown, bits: number): number | undefined {
  return typeof value === 'number' ? Number(BigInt.asIntN(bits, BigInt(value))) : undefined
}

function scalarValue(datatype: number, raw: Record<string, unknown>): unknown {
  switch (datatype) {
    case DataType.Int8:
      return signedValue(raw.intValue, 8)
    case DataType.Int16:
      return signedValue(raw.intValue, 16)
    case DataType.Int32:
      return signedValue(raw.intValue, 32)
    case DataType.UInt8:
    case DataType.UInt16:
    case DataType.UInt32:
      return raw.intValue
    case DataType.Int64:
      return typeof raw.longValue === 'string' ? BigInt.asIntN(64, BigInt(raw.longValue)).toString() : undefined
    case DataType.UInt64:
    case DataType.DateTime:
      return raw.longValue
    case DataType.Float:
      return raw.floatValue
    case DataType.Double:
      return raw.doubleValue
    case DataType.Boolean:
      return raw.booleanValue
    case DataType.String:
    case DataType.Text:
    case DataType.UUID:
      return raw.stringValue
    default:
      return undefined
  }
}

function formatMetric(metric: Metric, known: Definitions | undefined, warnings: Set<string>): Record<string, unknown> {
  const alias = metricAlias(metric)
  let definition = metric.name ? known?.names.get(metric.name) : undefined
  if (!metric.name && alias !== undefined) definition = known?.aliases.get(alias)
  const name = metric.name || definition?.name || undefined
  const datatype = metric.datatype || definition?.datatype || DataType.Unknown
  const raw: Record<string, unknown> = Payload.Metric.toObject(Payload.Metric.create(metric), jsonOptions)
  if (!name) warnings.add(`Unresolved alias ${alias ?? '(missing)'}; waiting for birth context.`)
  if (!datatype) warnings.add(`Missing datatype for ${name ?? alias ?? 'metric'}; waiting for birth context.`)
  let value: unknown = scalarValue(datatype, raw)
  if (metric.datasetValue) {
    const dataset = metric.datasetValue
    value = {
      ...(raw.datasetValue as Record<string, unknown>),
      types: dataset.types?.map(type => DataType[type] ?? type),
      rows: dataset.rows?.map(row => {
        return row.elements?.map((element, index) => {
          const fields: Record<string, unknown> = Payload.DataSet.DataSetValue.toObject(
            Payload.DataSet.DataSetValue.create(element),
            jsonOptions
          )
          const cell = scalarValue(dataset.types?.[index] ?? 0, fields)
          if (cell === undefined) warnings.add('Unsupported or missing dataset cell value; wire fields preserved.')
          return cell ?? fields
        })
      }),
    }
  }
  if (metric.templateValue) {
    value = {
      ...(raw.templateValue as Record<string, unknown>),
      metrics: metric.templateValue.metrics?.map(nested => {
        return formatMetric(nested, definitions(definition?.templateValue?.metrics ?? [], warnings), warnings)
      }),
    }
  }
  if (datatype === DataType.Bytes || datatype === DataType.File) value = raw.bytesValue
  if (datatype === DataType.PropertySet) value = raw.propertysetValue
  if (datatype === DataType.PropertySetList) value = raw.propertysetsValue
  if (datatype > DataType.PropertySetList) {
    // ponytail: keep array wire bytes; add typed-array expansion when needed.
    warnings.add(`Unsupported datatype ${DataType[datatype] ?? datatype}; wire fields preserved.`)
  }
  if (value === undefined && datatype && !metric.isNull) {
    warnings.add(`Missing or unsupported value for ${name ?? alias ?? 'metric'}; wire fields preserved.`)
  }
  return {
    ...raw,
    name,
    datatype,
    type: DataType[datatype] ?? 'Unknown',
    value: metric.isNull ? null : value,
  }
}

function decode(
  input: Base64Message,
  topic?: ReturnType<typeof parseTopic>,
  nodes = new Map<string, NodeBirth>()
): DecoderEnvelope {
  try {
    const payload = Payload.decode(input.toBuffer())
    const warnings = new Set<string>()
    if (payload.uuid === 'SPBV1.0_COMPRESSED') {
      throw new Error('Compressed Sparkplug payload is not expanded; raw bytes preserved.')
    }
    let node = topic && nodes.get(topic.nodeKey)
    const metrics = payload.metrics ?? []
    const bdSeq = metrics.find(metric => metric.name === 'bdSeq')?.longValue?.toString()
    if (topic?.messageType === 'NBIRTH') {
      node = { metrics: definitions(metrics, warnings), devices: new Map(), bdSeq }
      nodes.set(topic.nodeKey, node)
    } else if (topic?.messageType === 'DBIRTH') {
      node ??= { devices: new Map() }
      node.devices.set(topic.deviceId, definitions(metrics, warnings))
      nodes.set(topic.nodeKey, node)
    }
    const known = topic?.deviceId ? node?.devices.get(topic.deviceId) : node?.metrics
    const formatted = metrics.map(metric => formatMetric(metric, known, warnings))
    let status = known ? 'online' : 'unknown'
    if (topic?.messageType === 'NDEATH') {
      if (node?.bdSeq !== undefined && bdSeq !== undefined && node.bdSeq !== bdSeq) {
        warnings.add('Stale NDEATH: bdSeq differs from NBIRTH; current birth context preserved.')
      } else {
        nodes.delete(topic.nodeKey)
        status = 'offline'
      }
    } else if (topic?.messageType === 'DDEATH') {
      node?.devices.delete(topic.deviceId)
      status = 'offline'
    } else if (topic && !node?.metrics) {
      warnings.add('Missing NBIRTH; subscribe before the node publishes its next birth.')
    }
    if (topic?.deviceId && !known && topic.messageType !== 'DDEATH') {
      warnings.add('Missing DBIRTH; device aliases cannot be resolved.')
    }
    const raw: Record<string, unknown> = Payload.toObject(payload, jsonOptions)
    const message = Base64Message.fromString(
      JSON.stringify({
        ...raw,
        metrics: formatted,
        sparkplug: {
          ...(topic && {
            groupId: topic.groupId,
            edgeNodeId: topic.edgeNodeId,
            deviceId: topic.deviceId,
            messageType: topic.messageType,
          }),
          status,
          warnings: [...warnings],
        },
      })
    )
    return { message, decoder: Decoder.SPARKPLUG, error: [...warnings].join(' ') || undefined }
  } catch (error) {
    if (topic?.messageType === 'NBIRTH' || topic?.messageType === 'NDEATH') nodes.delete(topic.nodeKey)
    if (topic?.messageType === 'DBIRTH' || topic?.messageType === 'DDEATH') {
      nodes.get(topic.nodeKey)?.devices.delete(topic.deviceId)
    }
    return {
      message: input,
      error: `Failed to decode Sparkplug B payload: ${error instanceof Error ? error.message : String(error)}`,
      decoder: Decoder.NONE,
    }
  }
}

export class SparkplugSession {
  private nodes = new Map<string, NodeBirth>()

  public reset() {
    this.nodes.clear()
  }

  public observe(message: MqttMessage) {
    const topic = parseTopic(message.topic)
    if (!topic || !message.payload) return
    // Capture before UI buffering; history must never resolve against a later birth.
    const input = new Base64Message(message.payload)
    Object.assign(message, { payload: input })
    snapshots.set(input, decode(input, topic, this.nodes))
  }
}

export const SparkplugDecoder: MessageDecoder = {
  formats: ['Sparkplug'],
  canDecodeTopic(topic: string) {
    return !!parseTopic(topic)
  },
  decode(input) {
    return snapshots.get(input) ?? decode(input)
  },
}
