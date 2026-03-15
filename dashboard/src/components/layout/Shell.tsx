import type { ReactNode } from 'react';
import { Sidebar } from './Sidebar';
import { Header } from './Header';

const styles = {
  container: {
    display: 'flex',
    height: '100vh',
    background: 'var(--bg-primary)',
  } as const,
  main: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  } as const,
  content: {
    flex: 1,
    overflow: 'auto',
    padding: 'var(--space-6)',
  } as const,
};

export function Shell({ children }: { children: ReactNode }) {
  return (
    <div style={styles.container}>
      <Sidebar />
      <div style={styles.main}>
        <Header />
        <main style={styles.content}>{children}</main>
      </div>
    </div>
  );
}
