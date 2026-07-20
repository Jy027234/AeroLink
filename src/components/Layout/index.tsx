import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/store';
import { useIsMobile } from '@/hooks/use-mobile';

interface LayoutProps {
  children: React.ReactNode;
}

export function Layout({ children }: LayoutProps) {
  const { sidebarCollapsed } = useUIStore();
  const isMobile = useIsMobile();

  return (
    <div className="min-h-screen bg-gray-50" data-compact-viewport={isMobile ? 'true' : undefined}>
      <Sidebar />
      <div
        className={cn(
          'transition-all duration-300',
          // Mobile: no margin (sidebar is hidden/offcanvas)
          // Desktop: margin based on sidebar state
          'ml-0 md:ml-64',
          sidebarCollapsed && 'md:ml-20',
          isMobile && 'ml-0'
        )}
        data-layout-content
      >
        <Header />
        <main className="px-4 pb-4 pt-20 md:px-6 md:pb-6 md:pt-20">
          <div className="animate-fade-in">{children}</div>
        </main>
      </div>
    </div>
  );
}
