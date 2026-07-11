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
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/45 p-3 backdrop-blur-sm motion-safe:duration-200 motion-safe:animate-in motion-safe:fade-in md:p-8" role="dialog" aria-modal="true" aria-label={title}>
      <div className="leocodebox-settings-dialog flex h-[min(90vh,900px)] w-full max-w-7xl flex-col overflow-hidden rounded-2xl border border-border/70 bg-background shadow-2xl motion-safe:duration-200 motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95">
      <div className="leocodebox-main-header flex h-14 shrink-0 items-center justify-between border-b border-border/70 px-4">
        <div className="flex min-w-0 items-baseline gap-2">
          <strong className="truncate text-sm font-semibold text-foreground">{title}</strong>
          <span className="hidden text-xs text-muted-foreground sm:inline">leocodebox</span>
        </div>
        <button
          type="button"
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={onClose}
          aria-label={title}
          title={title}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <iframe className="min-h-0 flex-1 border-0 bg-background" src={src} title={title} allow="clipboard-write" />
      </div>
    </div>
  );
}
