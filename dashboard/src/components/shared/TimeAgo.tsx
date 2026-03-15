import { useState, useEffect } from 'react';
import { formatTimeAgo } from '../../utils/formatters';

export function TimeAgo({ timestamp }: { timestamp: string }) {
  const [text, setText] = useState(() => formatTimeAgo(timestamp));

  useEffect(() => {
    const id = setInterval(() => setText(formatTimeAgo(timestamp)), 30000);
    return () => clearInterval(id);
  }, [timestamp]);

  return <span title={new Date(timestamp).toLocaleString()}>{text}</span>;
}
