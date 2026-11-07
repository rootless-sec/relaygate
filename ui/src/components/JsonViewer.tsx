import React, { useState, useMemo } from 'react';
import { Check, Copy, Terminal } from 'lucide-react';

interface JsonViewerProps {
  jsonString: string;
  rawString?: string;
  curlCommand?: string;
  onToast?: (message: string) => void;
}

export const JsonViewer: React.FC<JsonViewerProps> = ({
  jsonString,
  rawString,
  curlCommand,
  onToast,
}) => {
  const [isPretty, setIsPretty] = useState(true);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const copyToClipboard = (text: string, label: string) => {
    try {
      navigator.clipboard.writeText(text);
      setCopiedKey(label);
      setTimeout(() => setCopiedKey(null), 1500);
      onToast?.(`${label} disalin ke clipboard`);
    } catch {
      onToast?.(`Gagal menyalin ${label}`);
    }
  };

  // Syntax highlight token generator for JSON
  const highlightedTokens = useMemo(() => {
    if (!isPretty) return null;

    let parsedText = jsonString;
    try {
      const parsed = JSON.parse(jsonString);
      parsedText = JSON.stringify(parsed, null, 2);
    } catch {}

    const tokenRegex =
      /("(?:\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?|[{}\[\]:,]/g;

    const elements: React.ReactNode[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = tokenRegex.exec(parsedText)) !== null) {
      if (match.index > lastIndex) {
        elements.push(parsedText.slice(lastIndex, match.index));
      }

      const str = match[0];
      const isKey = Boolean(match[2]);
      const isBoolNull = Boolean(match[3]);

      if (isKey) {
        const keyPart = match[1];
        const colonPart = match[2];
        elements.push(
          <span key={match.index} className="text-zinc-900 font-semibold">
            {keyPart}
          </span>
        );
        elements.push(
          <span key={`${match.index}-colon`} className="text-zinc-500">
            {colonPart}
          </span>
        );
      } else if (str.startsWith('"')) {
        elements.push(
          <span key={match.index} className="text-emerald-800">
            {str}
          </span>
        );
      } else if (isBoolNull) {
        if (str === 'null') {
          elements.push(
            <span key={match.index} className="text-zinc-400 italic font-medium">
              null
            </span>
          );
        } else {
          elements.push(
            <span key={match.index} className="text-indigo-700 font-medium">
              {str}
            </span>
          );
        }
      } else if (/^-?\d/.test(str)) {
        elements.push(
          <span key={match.index} className="text-blue-700 font-medium">
            {str}
          </span>
        );
      } else {
        elements.push(
          <span key={match.index} className="text-zinc-500">
            {str}
          </span>
        );
      }

      lastIndex = tokenRegex.lastIndex;
    }

    if (lastIndex < parsedText.length) {
      elements.push(parsedText.slice(lastIndex));
    }

    return elements;
  }, [jsonString, isPretty]);

  return (
    <div className="border border-zinc-200/90 rounded-lg overflow-hidden bg-white">
      {/* Navattic Section Card Header Bar */}
      <div className="px-3.5 py-2 bg-zinc-50/90 border-b border-zinc-200/80 flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-700">JSON Body</span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setIsPretty(!isPretty)}
            className="px-2 py-1 text-[11px] font-medium bg-white hover:bg-zinc-100 border border-zinc-200/90 text-zinc-800 rounded transition-colors cursor-pointer"
            aria-label="Ganti mode tampilan JSON"
          >
            {isPretty ? 'Raw' : 'Pretty'}
          </button>
          <button
            type="button"
            onClick={() =>
              copyToClipboard(isPretty ? jsonString : rawString || jsonString, 'Payload')
            }
            className="px-2 py-1 text-[11px] font-medium bg-white hover:bg-zinc-100 border border-zinc-200/90 text-zinc-800 rounded transition-colors flex items-center gap-1 cursor-pointer"
            aria-label="Salin payload JSON"
          >
            {copiedKey === 'Payload' ? (
              <>
                <Check className="w-3 h-3 text-emerald-600" />
                <span className="text-emerald-700">Disalin!</span>
              </>
            ) : (
              <>
                <Copy className="w-3 h-3 text-zinc-500" />
                <span>Salin</span>
              </>
            )}
          </button>
          {curlCommand && (
            <button
              type="button"
              onClick={() => copyToClipboard(curlCommand, 'cURL')}
              className="px-2 py-1 text-[11px] font-medium bg-white hover:bg-zinc-100 border border-zinc-200/90 text-zinc-800 rounded transition-colors flex items-center gap-1 cursor-pointer"
              aria-label="Salin perintah cURL"
            >
              {copiedKey === 'cURL' ? (
                <>
                  <Check className="w-3 h-3 text-emerald-600" />
                  <span className="text-emerald-700">Disalin!</span>
                </>
              ) : (
                <>
                  <Terminal className="w-3 h-3 text-zinc-500" />
                  <span>Salin cURL</span>
                </>
              )}
            </button>
          )}
        </div>
      </div>

      <pre className="p-3.5 bg-white text-xs font-mono text-zinc-900 overflow-auto max-h-[420px] whitespace-pre-wrap break-all select-text leading-relaxed">
        {isPretty ? highlightedTokens : rawString || jsonString}
      </pre>
    </div>
  );
};
