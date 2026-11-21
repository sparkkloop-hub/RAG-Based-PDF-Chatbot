import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';

interface MarkdownRendererProps {
  content: string;
}

function CodeBlock({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const match = /language-(\w+)/.exec(className || '');
  const language = match ? match[1] : 'text';
  const codeText = String(children).replace(/\n$/, '');

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(codeText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard blocked
    }
  };

  return (
    <div className="my-3 rounded-[8px] overflow-hidden border border-line bg-code">
      <div className="flex items-center justify-between px-3 py-1.5 bg-panel border-b border-line text-[12px] text-ink-secondary">
        <span className="font-mono lowercase">{language}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1 text-[12px] text-ink-secondary hover:text-ink transition-colors duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-[4px] px-1 py-0.5"
        >
          {copied ? (
            <Check className="w-3.5 h-3.5 text-status-success" strokeWidth={1.5} />
          ) : (
            <Copy className="w-3.5 h-3.5" strokeWidth={1.5} />
          )}
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <pre className="p-3.5 overflow-x-auto text-[13px] leading-[1.6] text-ink font-mono">
        <code>{codeText}</code>
      </pre>
    </div>
  );
}

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  return (
    <div className="text-[14px] leading-[1.65] text-ink space-y-3 break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="text-[20px] font-semibold tracking-tight text-ink mt-5 mb-2 first:mt-0 leading-[1.3]">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-[16px] font-semibold tracking-tight text-ink mt-4 mb-1.5 first:mt-0 leading-[1.35]">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-[14px] font-semibold text-ink mt-3.5 mb-1 first:mt-0 leading-[1.4]">
              {children}
            </h3>
          ),
          p: ({ children }) => <p className="text-[14px] leading-[1.65] text-ink">{children}</p>,
          ul: ({ children }) => (
            <ul className="list-disc pl-5 space-y-1 text-ink">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal pl-5 space-y-1 text-ink">{children}</ol>
          ),
          li: ({ children }) => <li className="leading-[1.6]">{children}</li>,
          strong: ({ children }) => (
            <strong className="font-semibold text-ink">{children}</strong>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-line-strong pl-3.5 py-0.5 text-[13px] text-ink-secondary my-3">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="border-line my-4" />,
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:underline underline-offset-2"
            >
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="my-3 overflow-x-auto rounded-[8px] border border-line">
              <table className="w-full text-left text-[13px] border-collapse">{children}</table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="bg-panel text-ink-secondary border-b border-line">
              {children}
            </thead>
          ),
          th: ({ children }) => (
            <th className="px-3 py-2 font-medium text-[12px]">{children}</th>
          ),
          td: ({ children }) => (
            <td className="px-3 py-2 border-t border-line text-ink">{children}</td>
          ),
          code: ({ className, children, ...props }) => {
            const isBlock = Boolean(className) || String(children).includes('\n');
            if (isBlock) {
              return <CodeBlock className={className}>{children}</CodeBlock>;
            }
            return (
              <code
                {...props}
                className="font-mono text-[12.5px] px-1.5 py-0.5 rounded-[4px] bg-raised text-ink"
              >
                {children}
              </code>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
