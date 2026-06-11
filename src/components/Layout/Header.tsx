import { useState } from 'react';
import { Search, Bell, User, LogOut, ChevronDown, Settings, Menu, Globe } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Badge } from '@/components/ui/badge';
import { useAuthStore, useUIStore, useNotificationStore } from '@/store';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';

export function Header() {
  const { currentPage, setMobileSidebarOpen, sidebarCollapsed } = useUIStore();
  const { user, logout } = useAuthStore();
  const setCurrentPage = useUIStore((state) => state.setCurrentPage);
  const { notifications, unreadCount, markAllAsRead } = useNotificationStore();
  const [searchQuery, setSearchQuery] = useState('');
  const { t, locale, setLocale } = useTranslation();

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    console.log('搜索:', searchQuery);
  };

  const handleNavigate = (page: string) => {
    setCurrentPage(page);
  };

  return (
    <header
      className={cn(
        'h-16 bg-white border-b border-gray-200 fixed top-0 right-0 z-40 flex items-center justify-between px-4 md:px-6',
        'left-0',
        sidebarCollapsed ? 'md:left-20' : 'md:left-64'
      )}
    >
      {/* 左侧：移动端菜单按钮 + 页面标题 */}
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden"
          onClick={() => setMobileSidebarOpen(true)}
        >
          <Menu className="w-5 h-5 text-gray-600" />
        </Button>
        <h2 className="text-lg md:text-xl font-semibold text-gray-900 truncate">
          {t(`pages.${currentPage}`)}
        </h2>
      </div>

      {/* 右侧操作区 */}
      <div className="flex items-center gap-2 md:gap-4">
        {/* 搜索框 - 移动端隐藏，平板及以上显示 */}
        <form onSubmit={handleSearch} className="relative hidden sm:block">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <Input
            type="search"
            placeholder={t('header.search')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-48 lg:w-64 pl-10 h-9 bg-gray-50 border-gray-200 focus:bg-white"
          />
        </form>

        {/* 移动端搜索按钮 */}
        <Button variant="ghost" size="icon" className="sm:hidden">
          <Search className="w-5 h-5 text-gray-600" />
        </Button>

        {/* 语言切换 */}
        <Button
          variant="ghost"
          size="sm"
          className="hidden sm:flex items-center gap-1 text-xs"
          onClick={() => setLocale(locale === 'zh-CN' ? 'en' : 'zh-CN')}
        >
          <Globe className="w-4 h-4" />
          {locale === 'zh-CN' ? t('language.chinese') : t('language.english')}
        </Button>

        {/* 通知图标 */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="relative">
              <Bell className="w-5 h-5 text-gray-600" />
              {unreadCount > 0 && (
                <Badge
                  variant="destructive"
                  className="absolute -top-1 -right-1 h-5 min-w-5 flex items-center justify-center text-xs animate-pulse"
                >
                  {unreadCount}
                </Badge>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-72 md:w-80">
            <DropdownMenuLabel className="flex items-center justify-between">
              <span>{t('header.notifications')}</span>
              {unreadCount > 0 && (
                <button
                  onClick={markAllAsRead}
                  className="text-xs text-brand-primary hover:underline"
                >
                  {t('header.markAllRead')}
                </button>
              )}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {notifications.length === 0 ? (
              <div className="py-8 text-center text-gray-500 text-sm">{t('header.noNotifications')}</div>
            ) : (
              <div className="max-h-80 overflow-y-auto">
                {notifications.slice(0, 5).map((notification) => (
                  <DropdownMenuItem
                    key={notification.id}
                    className={cn(
                      'flex flex-col items-start gap-1 p-3 cursor-pointer',
                      !notification.isRead && 'bg-blue-50'
                    )}
                  >
                    <div className="flex items-center gap-2 w-full">
                      <span
                        className={cn(
                          'w-2 h-2 rounded-full',
                          notification.type === 'error' && 'bg-red-500',
                          notification.type === 'warning' && 'bg-yellow-500',
                          notification.type === 'success' && 'bg-green-500',
                          notification.type === 'info' && 'bg-blue-500'
                        )}
                      />
                      <span className="font-medium text-sm flex-1">{notification.title}</span>
                      {!notification.isRead && (
                        <span className="w-2 h-2 bg-blue-500 rounded-full" />
                      )}
                    </div>
                    <p className="text-xs text-gray-500 line-clamp-2 pl-4">
                      {notification.message}
                    </p>
                    <span className="text-xs text-gray-400 pl-4">
                      {new Date(notification.createdAt).toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US')}
                    </span>
                  </DropdownMenuItem>
                ))}
              </div>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* 用户头像 */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="flex items-center gap-2 px-1 md:px-2">
              <div className="w-8 h-8 bg-brand-primary rounded-full flex items-center justify-center">
                <User className="w-4 h-4 text-white" />
              </div>
              <div className="text-left hidden sm:block">
                <p className="text-sm font-medium">{user?.name || 'User'}</p>
                <p className="text-xs text-gray-500">{user?.role === 'manager' ? t('header.manager') : t('header.sales')}</p>
              </div>
              <ChevronDown className="w-4 h-4 text-gray-400 hidden sm:block" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>{t('header.myAccount')}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => handleNavigate('settings')}>
              <User className="w-4 h-4 mr-2" />
              {t('header.profile')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleNavigate('settings')}>
              <Settings className="w-4 h-4 mr-2" />
              {t('nav.settings')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={logout} className="text-red-600">
              <LogOut className="w-4 h-4 mr-2" />
              {t('header.logout')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
