import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';

type LazySyntaxHighlighterProps = {
  language: string;
  raw: string;
  isDarkMode: boolean;
};

export default function LazySyntaxHighlighter({ language, raw, isDarkMode }: LazySyntaxHighlighterProps) {
  return (
    <SyntaxHighlighter
      language={language}
      style={isDarkMode ? oneDark : oneLight}
      customStyle={{
        margin: 0,
        borderRadius: '0.75rem',
        fontSize: '0.875rem',
        padding: language !== 'text' ? '2rem 1rem 1rem' : '1rem',
        ...(isDarkMode ? {} : { background: 'hsl(var(--muted))' }),
      }}
      codeTagProps={{
        style: {
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
          ...(isDarkMode ? {} : { background: 'transparent' }),
        },
      }}
    >
      {raw}
    </SyntaxHighlighter>
  );
}
