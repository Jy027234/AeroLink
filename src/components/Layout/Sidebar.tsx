// Sidebar component with collapsible navigation groups
import { useState, useEffect } from 'react';
import {
  LayoutDashboard,
  Inbox,
  Package,
  FileText,
  ClipboardList,
  Users,
  UserCircle,
  Truck,
  BarChart3,
  Settings,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Wrench,
  Building2,
  Code,
  RefreshCw,
  TrendingUp,
  MapPin,
  Bot,
  ShieldCheck,
  Award,
  FileCheck,
  GitBranch,
  ClipboardCheck,
  Gavel,
  Handshake,
  ChevronDown,
  Search,
  Store,
  Link,
  Boxes,
  ShoppingCart,
  PieChart,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import { useCapabilityStore, useUIStore } from '@/store';
import { useQuotations, useRFQs } from '@/hooks/useApi';
import { getPageCapability, hasCapability } from '@/lib/capabilities';
import { preloadPage } from '@/lib/pagePreload';
import { beginPageNavigation } from '@/lib/performanceMetrics';
import { Badge } from '@/components/ui/badge';
import {
  Collapsible,
  CollapsibleContent,
} from '@/components/ui/collapsible';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@/components/ui/sheet';

// ============================================
// Navigation Item Types
// ============================================

interface NavItem {
  id: string;
  icon: React.ElementType;
  badge?: number;
  group?: string;
  beta?: boolean;
}

interface NavGroup {
  id: string;
  icon: React.ElementType;
  items: NavItem[];
}

// ============================================
// Navigation Configuration
// ============================================

const navKeyMap: Record<string, string> = {
  dashboard: 'nav.dashboard',
  'agent-workbench': 'nav.agentWorkbench',
  ingestion: 'nav.ingestion',
  'rfq-management': 'nav.rfqManagement',
  inventory: 'nav.inventory',
  sourcing: 'nav.sourcing',
  quotations: 'nav.quotations',
  orders: 'nav.orders',
  customers: 'nav.customers',
  suppliers: 'nav.suppliers',
  'supplier-quotes': 'nav.supplierQuotes',
  'technical-kit': 'nav.technicalKit',
  'supplier-portal': 'nav.supplierPortal',
  'exchange-vmi': 'nav.exchangeVmi',
  'pricing-bi': 'nav.pricingBi',
  'order-tracking': 'nav.orderTracking',
  certificates: 'nav.certificates',
  'certificate-templates': 'nav.certificateTemplates',
  workflows: 'nav.workflows',
  auctions: 'nav.auctions',
  consignments: 'nav.consignments',
  'audit-logs': 'nav.auditLogs',
  'api-platform': 'nav.apiPlatform',
  'fmv-platform': 'nav.fmvPlatform',
  'blockchain-verification': 'nav.blockchainVerification',
  reports: 'nav.reports',
  settings: 'nav.settings',
  groupSourcing: 'nav.groupSourcing',
  groupOrderInventory: 'nav.groupOrderInventory',
  groupCustomerSupplier: 'nav.groupCustomerSupplier',
  groupQuality: 'nav.groupQuality',
  groupPlatform: 'nav.groupPlatform',
};

// Fixed top-level items (always visible)
const fixedTopItems: NavItem[] = [
  { id: 'dashboard', icon: LayoutDashboard },
  { id: 'agent-workbench', icon: Bot },
  { id: 'ingestion', icon: Inbox, badge: 2 },
];

// Collapsible groups
const navGroups: NavGroup[] = [
  {
    id: 'groupSourcing',
    icon: Search,
    items: [
      { id: 'rfq-management', icon: ClipboardList },
      { id: 'sourcing', icon: Truck },
      { id: 'quotations', icon: FileText, badge: 3 },
    ],
  },
  {
    id: 'groupOrderInventory',
    icon: Package,
    items: [
      { id: 'orders', icon: ShoppingCart },
      { id: 'order-tracking', icon: MapPin, beta: true },
      { id: 'inventory', icon: Boxes },
      { id: 'exchange-vmi', icon: RefreshCw, beta: true },
    ],
  },
  {
    id: 'groupCustomerSupplier',
    icon: Users,
    items: [
      { id: 'customers', icon: UserCircle },
      { id: 'suppliers', icon: Truck },
      { id: 'supplier-quotes', icon: FileText },
      { id: 'supplier-portal', icon: Building2 },
    ],
  },
  {
    id: 'groupQuality',
    icon: ShieldCheck,
    items: [
      { id: 'certificates', icon: Award },
      { id: 'certificate-templates', icon: FileCheck },
      { id: 'workflows', icon: GitBranch },
      { id: 'audit-logs', icon: ClipboardCheck },
    ],
  },
  {
    id: 'groupPlatform',
    icon: Store,
    items: [
      { id: 'technical-kit', icon: Wrench, beta: true },
      { id: 'auctions', icon: Gavel },
      { id: 'consignments', icon: Handshake },
      { id: 'pricing-bi', icon: BarChart3, beta: true },
      { id: 'api-platform', icon: Code },
      { id: 'fmv-platform', icon: TrendingUp },
      { id: 'blockchain-verification', icon: Link },
    ],
  },
];

// Fixed bottom-level items
const fixedBottomItems: NavItem[] = [
  { id: 'reports', icon: PieChart },
  { id: 'settings', icon: Settings },
];

// ============================================
// Helper: find which group contains the current page
// ============================================
function findGroupForPage(pageId: string): string | null {
  for (const group of navGroups) {
    if (group.items.some((item) => item.id === pageId)) {
      return group.id;
    }
  }
  return null;
}

// ============================================
// NavButton component
// ============================================
function NavButton({
  item,
  isActive,
  badgeCount,
  collapsed,
  onClick,
}: {
  item: NavItem;
  isActive: boolean;
  badgeCount: number;
  collapsed: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const Icon = item.icon;
  const translationKey = navKeyMap[item.id];
  const label = translationKey ? t(translationKey) : item.id;

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => preloadPage(item.id)}
      onFocus={() => preloadPage(item.id)}
      onTouchStart={() => preloadPage(item.id)}
      className={cn(
        'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-200 group relative',
        isActive
          ? 'bg-brand-primary/10 text-brand-primary border-l-4 border-brand-primary'
          : 'text-white/70 hover:bg-white/5 hover:text-white border-l-4 border-transparent'
      )}
    >
      <Icon className={cn('w-5 h-5 flex-shrink-0', isActive && 'text-brand-primary')} />
      {!collapsed && (
        <>
          <span className="text-sm font-medium flex-1 text-left">{label}</span>
          {item.beta && (
            <Badge
              variant="secondary"
              className="h-5 min-w-5 flex items-center justify-center text-[10px] bg-amber-500/20 text-amber-300 border-amber-500/30"
            >
              BETA
            </Badge>
          )}
          {badgeCount > 0 && (
            <Badge
              variant="destructive"
              className="h-5 min-w-5 flex items-center justify-center text-xs bg-destructive"
            >
              {badgeCount}
            </Badge>
          )}
          {item.id === 'ingestion' && badgeCount > 0 && (
            <AlertTriangle className="w-4 h-4 text-destructive animate-pulse" />
          )}
        </>
      )}
      {collapsed && badgeCount > 0 && (
        <span className="absolute -top-1 -right-1 w-4 h-4 bg-destructive rounded-full text-xs flex items-center justify-center">
          {badgeCount}
        </span>
      )}
    </button>
  );
}

// ============================================
// GroupButton component (collapsible group header)
// ============================================
function GroupButton({
  group,
  isOpen,
  collapsed,
  onClick,
}: {
  group: NavGroup;
  isOpen: boolean;
  collapsed: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const Icon = group.icon;
  const translationKey = navKeyMap[group.id];
  const label = translationKey ? t(translationKey) : group.id;

  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-200',
        'text-white/50 hover:bg-white/5 hover:text-white/80 border-l-4 border-transparent'
      )}
    >
      <Icon className="w-5 h-5 flex-shrink-0" />
      {!collapsed && (
        <>
          <span className="text-xs font-semibold uppercase tracking-wider flex-1 text-left">
            {label}
          </span>
          <ChevronDown
            className={cn(
              'w-4 h-4 transition-transform duration-200',
              isOpen && 'rotate-180'
            )}
          />
        </>
      )}
    </button>
  );
}

// ============================================
// SidebarContent component
// ============================================
function SidebarContent({ collapsed = false, onNavigate }: { collapsed?: boolean; onNavigate?: () => void }) {
  const { currentPage, setCurrentPage } = useUIStore();
  const { pagination: rfqBadgePagination } = useRFQs({
    status: 'pending',
    urgency: 'aog',
    page: 1,
    limit: 1,
  });
  const { pagination: quotationBadgePagination } = useQuotations({
    status: 'pending_approval',
    page: 1,
    limit: 1,
  });
  const capabilityGrants = useCapabilityStore((state) => state.grants);
  const capabilitiesLoaded = useCapabilityStore((state) => state.loaded);
  const { t } = useTranslation();

  const isItemVisible = (item: NavItem) => capabilitiesLoaded
    && hasCapability(capabilityGrants, getPageCapability(item.id));
  const visibleTopItems = fixedTopItems.filter(isItemVisible);
  const visibleGroups = navGroups
    .map((group) => ({ ...group, items: group.items.filter(isItemVisible) }))
    .filter((group) => group.items.length > 0);
  const visibleBottomItems = fixedBottomItems.filter(isItemVisible);

  // Track which groups are open
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());

  // Auto-expand the group containing the current page
  useEffect(() => {
    const activeGroupId = findGroupForPage(currentPage);
    if (!activeGroupId) return;
    setOpenGroups((prev) => (prev.has(activeGroupId) ? prev : new Set([...prev, activeGroupId])));
  }, [currentPage]);

  // Calculate badge count
  const getBadgeCount = (itemId: string): number => {
    switch (itemId) {
      case 'ingestion':
        return rfqBadgePagination?.total ?? 0;
      case 'quotations':
        return quotationBadgePagination?.total ?? 0;
      default:
        return 0;
    }
  };

  const handleItemClick = (itemId: string) => {
    beginPageNavigation(itemId, 'sidebar');
    setCurrentPage(itemId);
    onNavigate?.();
  };

  const toggleGroup = (groupId: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  };

  const setGroupOpen = (groupId: string, open: boolean) => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (open) {
        next.add(groupId);
      } else {
        next.delete(groupId);
      }
      return next;
    });
  };

  return (
    <>
      {/* Logo */}
      <div className="h-20 flex items-center px-5 border-b border-white/10">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-brand-primary rounded-lg flex items-center justify-center flex-shrink-0">
            <span className="text-white font-bold text-lg">A</span>
          </div>
          {!collapsed && (
            <div className="overflow-hidden">
              <h1 className="font-bold text-lg whitespace-nowrap">{t('app.name')}</h1>
              <p className="text-xs text-white/60 whitespace-nowrap">{t('app.subtitle')}</p>
            </div>
          )}
        </div>
      </div>

      {/* Navigation */}
      <nav className="p-3 space-y-1 overflow-y-auto h-[calc(100vh-140px)]">
        {/* Fixed top items */}
        {visibleTopItems.map((item) => (
          <NavButton
            key={item.id}
            item={item}
            isActive={currentPage === item.id}
            badgeCount={getBadgeCount(item.id)}
            collapsed={collapsed}
            onClick={() => handleItemClick(item.id)}
          />
        ))}

        {/* Separator */}
        <div className="my-2 border-t border-white/10" />

        {/* Collapsible groups */}
        {!collapsed ? (
          // Expanded sidebar: show collapsible groups
          visibleGroups.map((group) => {
            const isOpen = openGroups.has(group.id);
            return (
              <Collapsible
                key={group.id}
                open={isOpen}
                onOpenChange={(open) => setGroupOpen(group.id, open)}
              >
                <GroupButton
                  group={group}
                  isOpen={isOpen}
                  collapsed={collapsed}
                  onClick={() => setGroupOpen(group.id, !isOpen)}
                />
                <CollapsibleContent>
                  <div className="ml-4 space-y-0.5 mt-1 mb-1">
                    {group.items.map((item) => (
                      <NavButton
                        key={item.id}
                        item={item}
                        isActive={currentPage === item.id}
                        badgeCount={getBadgeCount(item.id)}
                        collapsed={collapsed}
                        onClick={() => handleItemClick(item.id)}
                      />
                    ))}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            );
          })
        ) : (
          // Collapsed sidebar: show group icons with tooltip
          visibleGroups.map((group) => {
            const Icon = group.icon;
            const isOpen = openGroups.has(group.id);
            const hasActivePage = group.items.some((item) => item.id === currentPage);
            const translationKey = navKeyMap[group.id];
            const label = translationKey ? t(translationKey) : group.id;

            return (
              <div key={group.id} className="relative group">
                <button
                  onClick={() => toggleGroup(group.id)}
                  className={cn(
                    'w-full flex items-center justify-center py-3 rounded-lg transition-all duration-200',
                    hasActivePage
                      ? 'bg-brand-primary/10 text-brand-primary'
                      : 'text-white/50 hover:bg-white/5 hover:text-white/80'
                  )}
                  title={label}
                >
                  <Icon className="w-5 h-5" />
                </button>
                {/* Tooltip on hover */}
                <div
                  className={cn(
                    'absolute left-full top-0 ml-2 px-3 py-2 bg-slate-800 text-white text-xs rounded-lg shadow-xl transition-opacity duration-200 z-50 whitespace-nowrap',
                    isOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none',
                    'group-hover:opacity-100 group-hover:pointer-events-auto'
                  )}
                >
                  <p className="font-semibold mb-1">{label}</p>
                  {group.items.map((item) => {
                    const itemKey = navKeyMap[item.id];
                    const itemLabel = itemKey ? t(itemKey) : item.id;
                    return (
                      <button
                        key={item.id}
                        onClick={() => {
                          handleItemClick(item.id);
                          setOpenGroups((prev) => {
                            const next = new Set(prev);
                            next.delete(group.id);
                            return next;
                          });
                        }}
                        className={cn(
                          'block w-full text-left px-2 py-1 rounded hover:bg-white/10',
                          currentPage === item.id ? 'text-brand-primary' : 'text-white/70'
                        )}
                      >
                        {itemLabel}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })
        )}

        {/* Separator */}
        <div className="my-2 border-t border-white/10" />

        {/* Fixed bottom items */}
        {visibleBottomItems.map((item) => (
          <NavButton
            key={item.id}
            item={item}
            isActive={currentPage === item.id}
            badgeCount={getBadgeCount(item.id)}
            collapsed={collapsed}
            onClick={() => handleItemClick(item.id)}
          />
        ))}
      </nav>
    </>
  );
}

// ============================================
// Sidebar component (exported)
// ============================================
export function Sidebar() {
  const { sidebarCollapsed, toggleSidebar, mobileSidebarOpen, setMobileSidebarOpen } = useUIStore();

  return (
    <>
      {/* Desktop Sidebar */}
      <aside
        className={cn(
          'fixed left-0 top-0 h-screen bg-brand-sidebar text-white transition-all duration-300 z-50',
          'hidden md:block',
          sidebarCollapsed ? 'w-20' : 'w-64'
        )}
        data-sidebar-desktop
      >
        <SidebarContent collapsed={sidebarCollapsed} />

        {/* Collapse button */}
        <button
          onClick={toggleSidebar}
          aria-label={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
          title={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
          className="absolute bottom-4 right-4 w-8 h-8 bg-white/10 rounded-lg flex items-center justify-center hover:bg-white/20 transition-colors"
        >
          {sidebarCollapsed ? (
            <ChevronRight className="w-4 h-4" />
          ) : (
            <ChevronLeft className="w-4 h-4" />
          )}
        </button>
      </aside>

      {/* Mobile Sidebar Drawer */}
      <Sheet open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
        <SheetContent
          side="left"
          className="w-[280px] max-w-[85vw] bg-brand-sidebar text-white p-0 border-r-0"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            document.querySelector<HTMLButtonElement>('[data-mobile-nav-trigger]')?.focus();
          }}
        >
          <SheetTitle className="sr-only">Main navigation</SheetTitle>
          <SheetDescription className="sr-only">Choose a page to navigate</SheetDescription>
          <SidebarContent onNavigate={() => setMobileSidebarOpen(false)} />
        </SheetContent>
      </Sheet>
    </>
  );
}
