import { useState, useRef, useEffect } from 'react';

interface ExportButtonProps {
  onExport: (format: 'csv' | 'json') => void;
}

export function ExportButton({ onExport }: ExportButtonProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const buttonStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-1)',
    padding: 'var(--space-2) var(--space-3)',
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--border-radius-md)',
    color: 'var(--text-primary)',
    fontSize: 'var(--font-size-sm)',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  };

  const menuStyle: React.CSSProperties = {
    position: 'absolute',
    top: 'calc(100% + 4px)',
    right: 0,
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--border-radius-md)',
    overflow: 'hidden',
    zIndex: 50,
    minWidth: '120px',
  };

  const menuItemStyle: React.CSSProperties = {
    display: 'block',
    width: '100%',
    padding: 'var(--space-2) var(--space-3)',
    background: 'none',
    border: 'none',
    color: 'var(--text-primary)',
    fontSize: 'var(--font-size-sm)',
    cursor: 'pointer',
    textAlign: 'left',
  };

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button style={buttonStyle} onClick={() => setOpen((o) => !o)}>
        ↓ Export
      </button>
      {open && (
        <div style={menuStyle}>
          <button
            style={menuItemStyle}
            onClick={() => { onExport('csv'); setOpen(false); }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-tertiary)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'none'; }}
          >
            Export CSV
          </button>
          <button
            style={menuItemStyle}
            onClick={() => { onExport('json'); setOpen(false); }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-tertiary)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'none'; }}
          >
            Export JSON
          </button>
        </div>
      )}
    </div>
  );
}
