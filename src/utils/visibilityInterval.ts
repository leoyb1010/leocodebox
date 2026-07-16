/** Run a low-frequency callback only while the document is visible. */
export function startVisibleInterval(callback: () => void, intervalMs: number): () => void {
  let timer: number | null = null;
  let disposed = false;

  const clear = () => {
    if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  };
  const start = () => {
    clear();
    if (!disposed && document.visibilityState === 'visible') {
      timer = window.setInterval(callback, intervalMs);
    }
  };
  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible') callback();
    start();
  };

  start();
  document.addEventListener('visibilitychange', onVisibilityChange);
  return () => {
    disposed = true;
    clear();
    document.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
