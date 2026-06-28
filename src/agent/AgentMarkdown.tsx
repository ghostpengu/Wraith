import { Fragment, type ReactNode } from "react";

interface AgentMarkdownProps {
  text: string;
}

const HR_RE = /^(-{3,}|\*{3,}|_{3,})$/;
const HEADER_RE = /^(#{1,6})\s+(.+)$/;
const LIST_RE = /^(\s*)([-*])\s+(.*)$/;

function renderInline(text: string, keyPrefix: string) {
  const parts: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*|_[^_\n]+_)/g;
  let last = 0;
  let match: RegExpExecArray | null = null;
  let index = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) {
      parts.push(text.slice(last, match.index));
    }
    const token = match[0];
    if (token.startsWith("**")) {
      parts.push(
        <strong key={`${keyPrefix}-b-${index}`}>{token.slice(2, -2)}</strong>
      );
    } else if (token.startsWith("`")) {
      parts.push(
        <code key={`${keyPrefix}-c-${index}`} className="agent-md-code">
          {token.slice(1, -1)}
        </code>
      );
    } else {
      const inner = token.startsWith("*") ? token.slice(1, -1) : token.slice(1, -1);
      parts.push(<em key={`${keyPrefix}-i-${index}`}>{inner}</em>);
    }
    last = match.index + token.length;
    index += 1;
  }

  if (last < text.length) {
    parts.push(text.slice(last));
  }

  return parts;
}

interface ListEntry {
  indent: number;
  content: string;
}

function buildListTree(entries: ListEntry[], start: number, end: number, minIndent: number, keyPrefix: string) {
  const items: ReactNode[] = [];
  let i = start;

  while (i < end) {
    const entry = entries[i];
    if (entry.indent < minIndent) break;
    if (entry.indent > minIndent) {
      i += 1;
      continue;
    }

    let childEnd = i + 1;
    while (childEnd < end && entries[childEnd].indent > entry.indent) {
      childEnd += 1;
    }

    const hasChildren = childEnd > i + 1 && entries[i + 1].indent > entry.indent;

    items.push(
      <li key={`${keyPrefix}-li-${i}`}>
        {renderInline(entry.content, `${keyPrefix}-li-${i}`)}
        {hasChildren &&
          buildListTree(entries, i + 1, childEnd, entry.indent + 1, `${keyPrefix}-sub-${i}`)}
      </li>
    );
    i = childEnd;
  }

  return <ul className="agent-md-list">{items}</ul>;
}

function parseList(lines: string[], start: number, keyPrefix: string) {
  const entries: ListEntry[] = [];
  let i = start;

  while (i < lines.length) {
    const match = lines[i].match(LIST_RE);
    if (!match) break;
    entries.push({ indent: match[1].length, content: match[3] });
    i += 1;
  }

  return {
    node: buildListTree(entries, 0, entries.length, entries[0]?.indent ?? 0, keyPrefix),
    end: i,
  };
}

function parseCodeFence(lines: string[], start: number, keyPrefix: string) {
  const open = lines[start];
  const lang = open.slice(3).trim();
  const inner: string[] = [];
  let i = start + 1;

  while (i < lines.length && !lines[i].startsWith("```")) {
    inner.push(lines[i]);
    i += 1;
  }

  if (i < lines.length) i += 1;

  return {
    node: (
      <pre key={keyPrefix} className="agent-md-pre">
        <code data-lang={lang || undefined}>{inner.join("\n")}</code>
      </pre>
    ),
    end: i,
  };
}

function parseParagraph(lines: string[], start: number, keyPrefix: string) {
  const chunk: string[] = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) break;
    if (HR_RE.test(line.trim())) break;
    if (HEADER_RE.test(line)) break;
    if (LIST_RE.test(line)) break;
    if (line.startsWith("```")) break;
    chunk.push(line);
    i += 1;
  }

  return {
    node: (
      <p key={keyPrefix} className="agent-md-p">
        {chunk.map((line, lineIndex) => (
          <Fragment key={`${keyPrefix}-line-${lineIndex}`}>
            {lineIndex > 0 && <br />}
            {renderInline(line, `${keyPrefix}-line-${lineIndex}`)}
          </Fragment>
        ))}
      </p>
    ),
    end: i,
  };
}

const HEADER_TAGS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;

export function AgentMarkdown({ text }: AgentMarkdownProps) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const nodes: ReactNode[] = [];
  let i = 0;
  let blockIndex = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i += 1;
      continue;
    }

    if (HR_RE.test(line.trim())) {
      nodes.push(<hr key={`block-${blockIndex}`} className="agent-md-hr" />);
      i += 1;
      blockIndex += 1;
      continue;
    }

    const headerMatch = line.match(HEADER_RE);
    if (headerMatch) {
      const level = Math.min(headerMatch[1].length, 6);
      const Tag = HEADER_TAGS[level - 1];
      nodes.push(
        <Tag key={`block-${blockIndex}`} className={`agent-md-h agent-md-h${level}`}>
          {renderInline(headerMatch[2], `h${blockIndex}`)}
        </Tag>
      );
      i += 1;
      blockIndex += 1;
      continue;
    }

    if (LIST_RE.test(line)) {
      const { node, end } = parseList(lines, i, `block-${blockIndex}`);
      nodes.push(node);
      i = end;
      blockIndex += 1;
      continue;
    }

    if (line.startsWith("```")) {
      const { node, end } = parseCodeFence(lines, i, `block-${blockIndex}`);
      nodes.push(node);
      i = end;
      blockIndex += 1;
      continue;
    }

    const { node, end } = parseParagraph(lines, i, `block-${blockIndex}`);
    nodes.push(node);
    i = end;
    blockIndex += 1;
  }

  return <div className="agent-md">{nodes}</div>;
}