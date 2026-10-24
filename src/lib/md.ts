import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: false });

/** Markdown as Streamlit writes it (\$ escapes, **bold**, `code`) -> safe HTML. */
export function mdToHtml(src: string, inline = false): string {
  const html = inline ? (marked.parseInline(src) as string) : (marked.parse(src) as string);
  return DOMPurify.sanitize(html);
}

/** Raw HTML from st.markdown(..., unsafe_allow_html=True): keep inline styles, drop scripts. */
export function safeHtml(src: string): string {
  return DOMPurify.sanitize(src, { ADD_ATTR: ['style'] });
}
