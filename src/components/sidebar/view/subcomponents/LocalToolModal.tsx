import { useEffect } from 'react';
import { X } from 'lucide-react';

type LocalToolModalProps = {
  title: string;
  src: string;
  onClose: () => void;
};

export default function LocalToolModal({ title, src, onClose }: LocalToolModalProps) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-background" role="dialog" aria-modal="true" aria-label={title}>
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/70 px-4">
        <div className="flex min-w-0 items-baseline gap-2">
          <strong className="truncate text-sm font-semibold text-foreground">{title}</strong>
          <span className="hidden text-xs text-muted-foreground sm:inline">leocodebox</span>
        </div>
        <button
          type="button"
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={onClose}
          aria-label="关闭"
          title="关闭"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <iframe className="min-h-0 flex-1 border-0 bg-background" src={src} title={title} />
    </div>
  );
}
