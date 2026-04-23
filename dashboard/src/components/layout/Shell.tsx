import type { ReactNode } from 'react';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { WelcomeBanner } from './WelcomeBanner';
import { WelcomeTour } from '../onboarding/WelcomeTour';
import { useTour } from '../onboarding/TourProvider';

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
  const { tourOpen, closeTour } = useTour();
  return (
    <div style={styles.container}>
      <Sidebar />
      <div style={styles.main}>
        <WelcomeBanner />
        <Header />
        <main style={styles.content}>{children}</main>
      </div>
      <WelcomeTour open={tourOpen} onClose={closeTour} />
    </div>
  );
}
