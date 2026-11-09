// The running system: each part lights up as a request reaches it.

export type NodeId = 'client' | 'worker' | 'issuer' | 'inbox' | 'members' | 'mppx' | 'tempo' | 'llm'

const nodes: Record<NodeId, { x: number; y: number; label: string; sub: string }> = {
  client: { x: 180, y: 40, label: 'Browser', sub: 'mppx client' },
  worker: { x: 180, y: 140, label: 'Worker', sub: 'GET /api/fortune' },
  issuer: { x: 400, y: 140, label: 'Email issuer', sub: '/issuer' },
  inbox: { x: 400, y: 250, label: 'Inbox', sub: 'one-time code' },
  members: { x: 16, y: 250, label: 'Member DB', sub: 'Identity.from' },
  mppx: { x: 180, y: 250, label: 'mppx charge', sub: 'identity + 402' },
  tempo: { x: 180, y: 360, label: 'Tempo', sub: 'testnet · pathUSD' },
  llm: { x: 400, y: 360, label: 'Workers AI', sub: 'small LLM haiku' },
}

const edges: [NodeId, NodeId][] = [
  ['client', 'worker'],
  ['client', 'issuer'],
  ['issuer', 'inbox'],
  ['worker', 'members'],
  ['worker', 'issuer'],
  ['worker', 'mppx'],
  ['mppx', 'tempo'],
  ['worker', 'llm'],
]

/** Which part each step runs in, and the edge it travels. */
export const stepNode: Record<string, { node: NodeId; edge?: [NodeId, NodeId] }> = {
  'client.request': { node: 'client' },
  'client.prover.email': { node: 'client' },
  'client.prover.member': { node: 'client' },
  'client.code': { node: 'inbox', edge: ['client', 'issuer'] },
  request: { node: 'worker', edge: ['client', 'worker'] },
  'identity.member': { node: 'members', edge: ['worker', 'members'] },
  'identity.email': { node: 'issuer', edge: ['worker', 'issuer'] },
  tier: { node: 'worker' },
  'identity.required': { node: 'mppx', edge: ['worker', 'mppx'] },
  'charge.challenge': { node: 'mppx', edge: ['worker', 'mppx'] },
  'charge.settled': { node: 'tempo', edge: ['mppx', 'tempo'] },
  'fortune.prompt': { node: 'llm', edge: ['worker', 'llm'] },
  'fortune.llm': { node: 'llm', edge: ['worker', 'llm'] },
  'issuer.otp': { node: 'issuer', edge: ['client', 'issuer'] },
  'issuer.email': { node: 'inbox', edge: ['issuer', 'inbox'] },
  'issuer.verify': { node: 'issuer', edge: ['client', 'issuer'] },
  'issuer.sign': { node: 'issuer', edge: ['client', 'issuer'] },
}

const width = 140
const height = 54

export function Diagram(props: {
  active?: string | undefined
  label?: string | undefined
  idle: NodeId[]
  visited: Set<NodeId>
}) {
  const current = props.active ? stepNode[props.active] : undefined
  const isEdge = (a: NodeId, b: NodeId) =>
    current?.edge &&
    ((current.edge[0] === a && current.edge[1] === b) ||
      (current.edge[0] === b && current.edge[1] === a))
  return (
    <svg className="diagram" viewBox="0 0 580 450" role="img" aria-label="Live architecture">
      <defs>
        <marker id="dot" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5">
          <circle cx="5" cy="5" r="4" fill="var(--green)" />
        </marker>
      </defs>
      {edges.map(([a, b]) => {
        const [from, to] = clip(a, b)
        const lit = isEdge(a, b)
        const idle = props.idle.includes(a) || props.idle.includes(b)
        return (
          <g key={`${a}-${b}`}>
            <line
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              className={`edge${lit ? ' lit' : ''}${idle ? ' idle' : ''}`}
              markerEnd={lit ? 'url(#dot)' : undefined}
            />
          </g>
        )
      })}
      {(Object.keys(nodes) as NodeId[]).map((id) => {
        const node = nodes[id]
        const lit = current?.node === id
        const idle = props.idle.includes(id)
        return (
          <g
            key={id}
            transform={`translate(${node.x}, ${node.y})`}
            className={`node${lit ? ' lit' : ''}${idle ? ' idle' : ''}${props.visited.has(id) ? ' visited' : ''}`}
          >
            <rect width={width} height={height} rx="10" />
            <text x="14" y="23" className="label">
              {node.label}
            </text>
            <text x="14" y="41" className="sub">
              {node.sub}
            </text>
          </g>
        )
      })}
      {current && props.label && (
        <foreignObject x="10" y="422" width="560" height="26">
          <div className="diagram-caption">{props.label}</div>
        </foreignObject>
      )}
    </svg>
  )
}

/** The edge between two nodes, trimmed to their borders so it never crosses a label. */
function clip(a: NodeId, b: NodeId) {
  const from = center(a)
  const to = center(b)
  const dx = to.x - from.x
  const dy = to.y - from.y
  const t = Math.min(
    dx ? width / 2 / Math.abs(dx) : Infinity,
    dy ? height / 2 / Math.abs(dy) : Infinity,
  )
  return [
    { x: from.x + dx * t, y: from.y + dy * t },
    { x: to.x - dx * t, y: to.y - dy * t },
  ] as const
}

function center(id: NodeId) {
  return { x: nodes[id].x + width / 2, y: nodes[id].y + height / 2 }
}
