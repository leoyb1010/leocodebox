import { Braces } from 'lucide-react';

export default function GrokLogo({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <span
      aria-label="Grok Build"
      role="img"
      title="Grok Build"
      className={`inline-flex items-center justify-center rounded-[30%] bg-foreground text-background ${className}`}
    >
      <Braces aria-hidden="true" className="h-[72%] w-[72%]" strokeWidth={2.4} />
    </span>
  );
}
