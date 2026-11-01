import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { MessageSegment, PlaceSegment, RouteSegment } from '../types'
import { PlaceChip, RouteChip } from './PlaceChip'
import { Markdown, markdownComponents } from '../lib/markdown'

const PLACE_TOKEN = '@@tpp'
const ROUTE_TOKEN = '@@tpr'
const TOKEN_RE = /@@tp([pr])(\d+)@@/g

/**
 * 行内地点 chip 的 Markdown 渲染（mindtrip/06 §1.3–§1.4）。
 *
 * 关键点：**不把正文按 segment 切块** —— 那样会把列表/段落切碎。
 * 先把 place/route 换成占位 token，正文整体交给 Markdown；再用一个 rehype 插件
 * 把 token 替换成 `<place-chip>` / `<route-chip>` 元素，交给自定义组件渲染。
 * 这样 chip 能出现在列表项、加粗、表格里，Markdown 结构完整保留。
 */
export function RichMessage({
  segments,
  fallback,
}: {
  segments?: MessageSegment[] | null
  fallback: string
}) {
  const places: PlaceSegment[] = []
  const routes: RouteSegment[] = []
  let markdown = ''
  let overflow = 0
  if (!segments?.length) {
    markdown = fallback
  } else {
    for (const segment of segments) {
      if (segment.type === 'text') {
        markdown += segment.text
      } else if (segment.type === 'place') {
        // 服务端已经限 20 个；这里再兜一层，保证旧数据/异常数据也不会刷屏（§1.5）
        if (places.length >= 20) {
          markdown += segment.name
          overflow += 1
          continue
        }
        markdown += `${PLACE_TOKEN}${places.length}@@`
        places.push(segment)
      } else {
        markdown += `${ROUTE_TOKEN}${routes.length}@@`
        routes.push(segment)
      }
    }
    if (overflow > 0) markdown += `\n\n还有 ${overflow} 个地点，可在地图上查看。`
  }

  if (!places.length && !routes.length) return <Markdown>{markdown || fallback}</Markdown>

  const components = {
    ...markdownComponents,
    'place-chip': ({ node }: any) => {
      const index = Number(node?.children?.[0]?.value ?? -1)
      const segment = places[index]
      return segment ? <PlaceChip segment={segment} /> : null
    },
    'route-chip': ({ node }: any) => {
      const index = Number(node?.children?.[0]?.value ?? -1)
      const segment = routes[index]
      if (!segment) return null
      return (
        <RouteChip
          fromPoiId={segment.fromPoiId}
          toPoiId={segment.toPoiId}
          fromName={segment.fromName}
          toName={segment.toName}
          mode={segment.mode}
          distanceM={segment.distanceM}
          durationMin={segment.durationMin}
        />
      )
    },
  } as any

  return (
    <div className="md-body rich-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeInlineChips]} components={components}>
        {markdown}
      </ReactMarkdown>
    </div>
  )
}

/** rehype 插件：把文本节点里的 `@@tpp3@@` 换成自定义元素，子节点记索引。 */
function rehypeInlineChips() {
  return (tree: any) => {
    const walk = (node: any) => {
      if (!Array.isArray(node.children)) return
      const next: any[] = []
      for (const child of node.children) {
        if (child.type === 'text' && typeof child.value === 'string' && child.value.includes('@@tp')) {
          const value: string = child.value
          let cursor = 0
          TOKEN_RE.lastIndex = 0
          let match: RegExpExecArray | null
          while ((match = TOKEN_RE.exec(value)) !== null) {
            if (match.index > cursor) next.push({ type: 'text', value: value.slice(cursor, match.index) })
            next.push({
              type: 'element',
              tagName: match[1] === 'p' ? 'place-chip' : 'route-chip',
              properties: {},
              children: [{ type: 'text', value: match[2] }],
            })
            cursor = match.index + match[0].length
          }
          if (cursor < value.length) next.push({ type: 'text', value: value.slice(cursor) })
        } else {
          walk(child)
          next.push(child)
        }
      }
      node.children = next
    }
    walk(tree)
  }
}
