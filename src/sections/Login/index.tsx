import { useState } from 'react';
import { Plane, Lock, Mail, Eye, EyeOff, Loader2, Globe, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAuthStore } from '@/store';
import { useLogin } from '@/hooks/useApi';
import { useTranslation } from '@/i18n';
import type { User } from '@/types';

export function Login() {
  const { login: storeLogin } = useAuthStore();
  const { login: apiLogin, loading: isLoading, error: apiError } = useLogin();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState('');
  const { locale, setLocale, t } = useTranslation();
  const switchLanguageLabel = locale === 'zh-CN' ? t('language.english') : t('language.chinese');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!email || !password) {
      setError(t('auth.pleaseEnterEmailPassword'));
      return;
    }

    // API登录
    const result = await apiLogin(email, password);
    
    if (result) {
      // API登录成功
      storeLogin(result.user as User);
    } else {
      // API登录失败，显示错误
      setError(apiError || t('auth.loginFailedCheckCredentials'));
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[#0a192f] via-[#1e3a5f] to-[#0a192f]">
      {/* 背景装饰 */}
      <div className="absolute inset-0 overflow-hidden">
        <div className="absolute top-20 left-20 w-72 h-72 bg-[#64b5f6]/10 rounded-full blur-3xl" />
        <div className="absolute bottom-20 right-20 w-96 h-96 bg-[#64b5f6]/5 rounded-full blur-3xl" />
      </div>

      {/* 登录卡片 */}
      <div className="relative w-full max-w-md mx-4">
        <div className="bg-white rounded-2xl shadow-2xl p-8">
          <div className="flex justify-end mb-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-9 gap-2 px-3 text-gray-600">
                  <Globe className="w-4 h-4" />
                  <span>{switchLanguageLabel}</span>
                  <ChevronDown className="w-4 h-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40">
                <DropdownMenuLabel>{t('language.switch')}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setLocale('zh-CN')}>
                  {t('language.chinese')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setLocale('en')}>
                  {t('language.english')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Logo */}
          <div className="text-center mb-8">
            <div className="w-20 h-20 bg-gradient-to-br from-[#64b5f6] to-[#42a5f5] rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg">
              <Plane className="w-10 h-10 text-white" />
            </div>
            <h1 className="text-2xl font-bold text-gray-900">{t('app.name')}</h1>
            <p className="text-gray-500 mt-1">{t('auth.loginTitle')}</p>
          </div>

          {/* 登录表单 */}
          <form onSubmit={handleSubmit} className="space-y-6">
            {error && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm text-center animate-pulse">
                {error}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="email">{t('auth.email')}</Label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                <Input
                  id="email"
                  type="email"
                  placeholder={t('auth.email')}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="pl-10 h-12"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">{t('auth.password')}</Label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                <Input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  placeholder={t('auth.password')}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="pl-10 pr-10 h-12"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                </button>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="remember"
                  checked={rememberMe}
                  onCheckedChange={(checked) => setRememberMe(checked as boolean)}
                />
                <Label htmlFor="remember" className="text-sm cursor-pointer">
                  {t('auth.rememberMe')}
                </Label>
              </div>
              <button type="button" className="text-sm text-[#64b5f6] hover:underline">
                {t('auth.forgotPassword')}
              </button>
            </div>

            <Button
              type="submit"
              className="w-full h-12 bg-[#64b5f6] hover:bg-[#42a5f5] text-lg font-medium"
              disabled={isLoading}
            >
              {isLoading ? (
                <>
                  <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                  {t('auth.loggingIn')}
                </>
              ) : (
                t('auth.login')
              )}
            </Button>
          </form>

          {/* 系统信息 */}
          <div className="mt-6 p-4 bg-blue-50 rounded-lg">
            <p className="text-sm text-blue-700 font-medium">{t('auth.systemInfoTitle')}</p>
            <p className="text-sm text-blue-600">{t('auth.systemInfoSubtitle')}</p>
          </div>

          {/* 版权信息 */}
          <p className="text-center text-sm text-gray-400 mt-6">
            {t('auth.copyright')}
          </p>
        </div>
      </div>
    </div>
  );
}
