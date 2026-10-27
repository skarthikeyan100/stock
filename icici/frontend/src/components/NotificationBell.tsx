import { useState, useEffect, useRef, useCallback } from 'react';
import { useEventSource } from '../hooks/useEventSource';
import { useAuth } from '../context/AuthContext';
import { apiFetch } from '../utils/api';

interface Notification {
  _id: string;
  type: 'drawdown_warning' | 'drawdown_breach' | 'payout_status';
  message: string;
  read: boolean;
  createdAt: string;
}

// Mounted individually in each page's existing header bar - there's no
// shared layout component today, so this stays additive rather than
// triggering a layout refactor.
export default function NotificationBell() {
  const { user } = useAuth();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Merge (dedupe by _id): a notification pushed over SSE while this fetch was in flight must not appear twice.
  const email = user?.email;
  const loadUnread = useCallback(() => {
    if (!email) return;
    apiFetch(`/users/${encodeURIComponent(email)}/notifications?unreadOnly=true`)
      .then(res => (res.ok ? res.json() : Promise.reject(new Error(`status ${res.status}`))))
      .then((data: Notification[]) => {
        if (!Array.isArray(data)) return;
        setNotifications(prev => {
          const seen = new Set(prev.map(n => n._id));
          return [...prev, ...data.filter(n => !seen.has(n._id))].sort(
            (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
          );
        });
      })
      .catch(() => {});
  }, [email]);

  useEventSource('/notificationstream', {
    enabled: !!email,
    // Anything emitted while the stream was down is only reachable by refetching on (re)connect.
    onOpen: loadUnread,
    onMessage: (e) => {
      try {
        const notification = JSON.parse(e.data) as Notification;
        setNotifications(prev => (prev.some(n => n._id === notification._id) ? prev : [notification, ...prev]));
      } catch { /* ignore malformed event */ }
    },
  });

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const markRead = async (id: string) => {
    if (!user) return;
    try {
      const res = await apiFetch(`/users/${encodeURIComponent(user.email)}/notifications/${id}/read`, { method: 'PATCH' });
      if (!res.ok) return; // keep it listed: the server did not record it as read
      setNotifications(prev => prev.filter(n => n._id !== id));
    } catch {
      /* network error: keep it listed */
    }
  };

  const unreadCount = notifications.length;

  return (
    <div ref={ref} className="position-relative d-inline-block">
      <button
        type="button"
        className="btn btn-outline-secondary btn-sm position-relative"
        onClick={() => setOpen(o => !o)}
      >
        🔔
        {unreadCount > 0 && (
          <span className="position-absolute top-0 start-100 translate-middle badge rounded-pill bg-danger" style={{ fontSize: '0.6rem' }}>
            {unreadCount}
          </span>
        )}
      </button>
      {open && (
        <div
          className="position-absolute end-0 mt-1 bg-white border rounded shadow-sm"
          style={{ width: 320, zIndex: 1000, maxHeight: 360, overflowY: 'auto' }}
        >
          {notifications.length === 0 ? (
            <div className="p-3 text-muted small text-center">No new notifications</div>
          ) : (
            notifications.map(n => (
              <div
                key={n._id}
                className="p-2 border-bottom small"
                style={{ cursor: 'pointer' }}
                onClick={() => markRead(n._id)}
                title="Click to mark as read"
              >
                <div className={n.type === 'drawdown_breach' ? 'text-danger fw-semibold' : ''}>{n.message}</div>
                <div className="text-muted" style={{ fontSize: '0.7rem' }}>{new Date(n.createdAt).toLocaleString()}</div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
