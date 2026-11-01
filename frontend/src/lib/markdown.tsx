import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export function Markdown({ children }: { children: string }) {
  return (
    <div className="md-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {children}
      </ReactMarkdown>
    </div>
  )
}

export const markdownComponents = {
  a: ({ children: c, href }: any) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {c}
    </a>
  ),
  // 表格必须有自己的容器：手机宽度放不下三列时横向滚动，而不是把列挤成一条
  table: ({ children: c }: any) => (
    <div className="md-table-wrap">
      <table>{c}</table>
    </div>
  ),
}
