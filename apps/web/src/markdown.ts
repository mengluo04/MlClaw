import MarkdownIt from "markdown-it";
const markdown = new MarkdownIt({ html: false, linkify: false, breaks: true });
// 不自动请求模型文本中嵌入的远程图片，避免信息被发送给第三方。
markdown.disable("image");
const fence = markdown.renderer.rules.fence!;
markdown.renderer.rules.fence = (tokens, index, options, env, renderer) =>
  `<div class="code-block"><button type="button" class="copy-code" aria-label="复制代码">复制代码</button>${fence(tokens, index, options, env, renderer)}</div>`;
export const renderMarkdown = (text: string) => markdown.render(text);
