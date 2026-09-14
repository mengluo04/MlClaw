import MarkdownIt from 'markdown-it';
/** 禁用原始 HTML 的 Markdown 渲染实例。 */
const markdown = new MarkdownIt({ html: false, linkify: false, breaks: true });
// 不自动请求模型文本中嵌入的远程图片，避免信息被发送给第三方。
markdown.disable('image');
/** Markdown 原有代码围栏渲染器。 */
const fence = markdown.renderer.rules.fence!;
markdown.renderer.rules.fence = (tokens, index, options, env, renderer) =>
  `<div class="code-block"><button type="button" class="copy-code" aria-label="复制代码">复制代码</button>${fence(tokens, index, options, env, renderer)}</div>`;
/** 渲染经过安全处理的 Markdown 内容。 */
export const renderMarkdown = (text: string) => markdown.render(text);
