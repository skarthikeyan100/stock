import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';

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

  useEffect(() => {
    if (!user) return;
    fetch(`/users/${encodeURIComponent(user.email)}/notifications?unreadOnly=true`)
      .then(res => res.json())
      .then(data => { if (Array.isArray(data)) setNotifications(data); })
      .catch(() => {});

    const source = new EventSource('/notificationstream');
    source.onmessage = (e) => {
      try {
        const notification = JSON.parse(e.data) as Notification;
        setNotifications(prev => [notification, ...prev]);
      } catch { /* ignore malformed event */ }
    };
    return () => source.close();
  }, [user?.email]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const markRead = async (id: string) => {
    if (!user) return;
    await fetch(`/users/${encodeURIComponent(user.email)}/notifications/${id}/read`, { method: 'PATCH' });
    setNotifications(prev => prev.filter(n => n._id !== id));
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
