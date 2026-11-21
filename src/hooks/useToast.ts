import { useCallback, useState } from 'react';
import type { ToastItem } from '../types';
import { createId } from '../utils/format';

export function useToast() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback(
    (type: ToastItem['type'], title: string, message?: string, durationMs = 4800) => {
      const id = createId('toast');
      setToasts((prev) => [...prev.slice(-3), { id, type, title, message }]);
      if (durationMs > 0) {
        setTimeout(() => {
          setToasts((prev) => prev.filter((t) => t.id !== id));
        }, durationMs);
      }
      return id;
    },
    []
  );

  return { toasts, addToast, dismissToast };
}
