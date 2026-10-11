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
      // Ensure it is formatted
      const parsed = JSON.parse(jsonString);
      parsedText = JSON.stringify(parsed, null, 2);
    } catch {
      // fallback to input text
    }

    // Regex to match JSON tokens:
    // 1: Key ("key":)
    // 2: String value ("...")
    // 3: Number
    // 4: Boolean (true/false)
    // 5: Null
    // 6: Punctuation & braces
    const tokenRegex = /("(?:\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?|[{}\[\]:,]/g;

    const elements: React.ReactNode[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = tokenRegex.exec(parsedText)) !== null) {
      // Append any whitespace or characters between tokens
      if (match.index > lastIndex) {
        elements.push(parsedText.slice(lastIndex, match.index));
      }

      const str = match[0];
      const isKey = Boolean(match[2]);
      const isBoolNull = Boolean(match[3]);

      if (isKey) {
        // Object key: e.g. "event_id":
        const keyPart = match[1];
        const colonPart = match[2];
        elements.push(
          <span key={match.index} className="text-[#0f172a] font-semibold">
            {keyPart}
          </span>
        );
        elements.push(
          <span key={`${match.index}-colon`} className="text-[#71717a]">
            {colonPart}
          </span>
        );
      } else if (str.startsWith('"')) {
        // String value: e.g. "payment.success"
        elements.push(
          <span key={match.index} className="text-emerald-800">
            {str}
          </span>
        );
      } else if (isBoolNull) {
        if (str === 'null') {
          elements.push(
            <span key={match.index} className="text-[#a1a1aa] italic font-medium">
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
        // Number
        elements.push(
          <span key={match.index} className="text-blue-700 font-medium">
            {str}
          </span>
        );
      } else {
        // Structural characters: { } [ ] ,
        elements.push(
          <span key={match.index} className="text-[#71717a]">
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
    <div className="space-y-2">
      <div className="flex items-center justify-between pb-1">
        <span className="text-xs text-[#52525b] font-medium">JSON Body</span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setIsPretty(!isPretty)}
            className="px-2 py-1 text-[11px] font-medium bg-[#f4f4f5] hover:bg-[#e4e4e7] text-[#18181b] rounded transition-colors"
            aria-label="Ganti mode tampilan JSON"
          >
            {isPretty ? 'Tampilan Mentah (Raw)' : 'Format Rapi (Pretty)'}
          </button>
          <button
            type="button"
            onClick={() => copyToClipboard(isPretty ? jsonString : rawString || jsonString, 'Payload')}
            className="px-2 py-1 text-[11px] font-medium bg-[#f4f4f5] hover:bg-[#e4e4e7] text-[#18181b] rounded transition-colors flex items-center gap-1"
            aria-label="Salin payload JSON"
          >
            {copiedKey === 'Payload' ? (
              <>
                <Check className="w-3 h-3 text-emerald-600" />
                <span className="text-emerald-700">Disalin!</span>
              </>
            ) : (
              <>
                <Copy className="w-3 h-3 text-[#71717a]" />
                <span>Salin</span>
              </>
            )}
          </button>
          {curlCommand && (
            <button
              type="button"
              onClick={() => copyToClipboard(curlCommand, 'cURL')}
              className="px-2 py-1 text-[11px] font-medium bg-[#f4f4f5] hover:bg-[#e4e4e7] text-[#18181b] rounded transition-colors flex items-center gap-1"
              aria-label="Salin perintah cURL"
            >
              {copiedKey === 'cURL' ? (
                <>
                  <Check className="w-3 h-3 text-emerald-600" />
                  <span className="text-emerald-700">Disalin!</span>
                </>
              ) : (
                <>
                  <Terminal className="w-3 h-3 text-[#71717a]" />
                  <span>Salin cURL</span>
                </>
              )}
            </button>
          )}
        </div>
      </div>

      <pre className="p-3 bg-[#fafafa] border border-[#e4e4e7] rounded-lg text-xs font-mono text-[#18181b] overflow-auto max-h-[460px] whitespace-pre-wrap break-all select-text leading-relaxed">
        {isPretty ? highlightedTokens : rawString || jsonString}
      </pre>
    </div>
  );
};
