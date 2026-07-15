import { useState, useEffect } from 'react';
import {
  Users,
  User,
  Mail,
  Phone,
  MapPin,
  AlertTriangle,
  CheckCircle,
  Clock,
  Plus,
  Search,
  Eye,
  Edit3,
  Loader2,
  DollarSign,
  Trash2,
  Briefcase,
  FileText,
  Package,
  Plane,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useCustomers, useQuotations, customerApi } from '@/hooks/useApi';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import type { Customer, CustomerContact, CompetitorListing, BuyerType } from '@/types';

type CustomerStatus = Customer['status'];

const statusConfig: Record<CustomerStatus, { label: string; color: string; bgColor: string; icon: React.ElementType }> = {
  active: { label: 'Active', color: 'text-green-600', bgColor: 'bg-green-50', icon: CheckCircle },
  inactive: { label: 'Inactive', color: 'text-gray-500', bgColor: 'bg-gray-50', icon: Clock },
  at_risk: { label: 'At Risk', color: 'text-red-600', bgColor: 'bg-red-50', icon: AlertTriangle },
};

const buyerTypeOptions = ['Broker', 'MRO', 'End User', 'OEM', 'Distributor'] as const;
const creditRatingOptions = ['A', 'B', 'C', 'D'] as const;
const qualityApprovalOptions = ['Pending', 'Approved', 'Rejected'] as const;
const priceLevelOptions = ['High', 'Medium', 'Low'] as const;
const contactRoleOptions = ['purchaser', 'quality_manager', 'engineering_manager', 'logistics', 'gm'] as const;

function CustomerStatusBadge({ status }: { status: CustomerStatus }) {
  const config = statusConfig[status];
  const { t } = useTranslation();
  const Icon = config.icon;
  const statusLabel =
    status === 'active'
      ? t('customers.active')
      : status === 'inactive'
        ? t('customers.inactive')
        : t('customers.atRisk');
  return (
    <Badge variant="outline" className={cn(config.bgColor, config.color, 'border')}>
      <Icon className="w-3 h-3 mr-1" />
      {statusLabel}
    </Badge>
  );
}

function BuyerTypeBadge({ type }: { type: string }) {
  const { t } = useTranslation();
  const labelMap: Record<string, string> = {
    Broker: t('customers.broker'),
    MRO: t('customers.mro'),
    'End User': t('customers.endUser'),
    OEM: t('customers.oem'),
    Distributor: t('customers.distributor'),
  };
  return (
    <Badge variant="secondary" className="text-xs">
      <Briefcase className="w-3 h-3 mr-1" />
      {labelMap[type] || type}
    </Badge>
  );
}

function CustomerDetailDialog({
  customer,
  isOpen,
  onClose,
}: {
  customer: Customer | null;
  isOpen: boolean;
  onClose: () => void;
}) {
  const { data: quotations } = useQuotations();
  const { t, locale } = useTranslation();

  if (!customer) return null;

  const quotesList = quotations || [];
  const customerQuotes = quotesList.filter((q) => q.customerId === customer.id);
  const totalQuotes = customerQuotes.length;
  const acceptedQuotes = customerQuotes.filter((q) => q.status === 'accepted').length;
  const totalRevenue = customerQuotes
    .filter((q) => q.status === 'accepted')
    .reduce((sum, q) => sum + q.totalPrice, 0);
  const dateLocale = locale === 'en' ? 'en-US' : 'zh-CN';

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {customer.name}
          </DialogTitle>
          <DialogDescription className="sr-only">{t('customers.detailDescription')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          <div className="flex justify-between items-start p-4 bg-gray-50 rounded-lg">
            <div>
              <p className="font-semibold text-lg">{customer.name}</p>
              <p className="text-sm text-gray-500">{customer.contactName}</p>
              <div className="mt-2">
                <BuyerTypeBadge type={customer.buyerType} />
              </div>
            </div>
            <CustomerStatusBadge status={customer.status} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <User className="w-4 h-4 text-gray-400" />
                <span>{customer.contactName}</span>
              </div>
              <div className="flex items-center gap-2">
                <Mail className="w-4 h-4 text-gray-400" />
                <span className="text-sm">{customer.email}</span>
              </div>
              <div className="flex items-center gap-2">
                <Phone className="w-4 h-4 text-gray-400" />
                <span>{customer.phone || '-'}</span>
              </div>
              <div className="flex items-center gap-2">
                <MapPin className="w-4 h-4 text-gray-400" />
                <span className="text-sm">{customer.registeredAddress || '-'}</span>
              </div>
              {customer.shipToAddress && (
                <div className="flex items-center gap-2">
                  <Package className="w-4 h-4 text-gray-400" />
                  <span className="text-sm">{t('customers.shipToAddress')}: {customer.shipToAddress}</span>
                </div>
              )}
              {customer.shipForAddress && (
                <div className="flex items-center gap-2">
                  <FileText className="w-4 h-4 text-gray-400" />
                  <span className="text-sm">{t('customers.shipForAddress')}: {customer.shipForAddress}</span>
                </div>
              )}
              {customer.shippingContactName && (
                <div className="flex items-center gap-2">
                  <User className="w-4 h-4 text-gray-400" />
                  <span className="text-sm">{t('customers.shippingContactName')}: {customer.shippingContactName} {customer.shippingContactPhone ? `(${customer.shippingContactPhone})` : ''}</span>
                </div>
              )}
            </div>
            <div className="space-y-3">
              <div>
                <p className="text-sm text-gray-400">{t('customers.creditLimit')}</p>
                <p className="font-semibold">${customer.creditLimit?.toLocaleString() || '-'}</p>
              </div>
              <div>
                <p className="text-sm text-gray-400">{t('customers.creditRating')}</p>
                <p className="font-semibold">{customer.creditRating || '-'}</p>
              </div>
              <div>
                <p className="text-sm text-gray-400">{t('customers.paymentTerms')}</p>
                <p className="font-semibold">{customer.paymentTerms || '-'}</p>
              </div>
              <div>
                <p className="text-sm text-gray-400">{t('customers.paymentMethod')}</p>
                <p className="font-semibold">{customer.paymentMethod || '-'}</p>
              </div>
              <div>
                <p className="text-sm text-gray-400">{t('customers.annualPurchase')}</p>
                <p className="font-semibold">${customer.annualRevenue?.toLocaleString() || '-'}</p>
              </div>
              <div>
                <p className="text-sm text-gray-400">{t('customers.lastOrder')}</p>
                <p className="font-semibold">
                  {customer.lastOrderDate
                    ? new Date(customer.lastOrderDate).toLocaleDateString(dateLocale)
                    : '-'}
                </p>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            {customer.vatNumber && (
              <div className="p-3 bg-gray-50 rounded-lg">
                <p className="text-sm text-gray-400">{t('customers.vatNumber')}</p>
                <p className="font-medium">{customer.vatNumber}</p>
              </div>
            )}
            {customer.iataCode && (
              <div className="p-3 bg-gray-50 rounded-lg">
                <p className="text-sm text-gray-400">{t('customers.iataCode')}</p>
                <p className="font-medium flex items-center gap-1"><Plane className="w-3 h-3" />{customer.iataCode}</p>
              </div>
            )}
            {customer.icaoCode && (
              <div className="p-3 bg-gray-50 rounded-lg">
                <p className="text-sm text-gray-400">{t('customers.icaoCode')}</p>
                <p className="font-medium">{customer.icaoCode}</p>
              </div>
            )}
            {customer.aocNumber && (
              <div className="p-3 bg-gray-50 rounded-lg">
                <p className="text-sm text-gray-400">{t('customers.aocNumber')}</p>
                <p className="font-medium">{customer.aocNumber}</p>
              </div>
            )}
            {customer.preferredIncoterm && (
              <div className="p-3 bg-gray-50 rounded-lg">
                <p className="text-sm text-gray-400">{t('customers.preferredIncoterm')}</p>
                <p className="font-medium">{customer.preferredIncoterm}</p>
              </div>
            )}
            {customer.customsBroker && (
              <div className="p-3 bg-gray-50 rounded-lg">
                <p className="text-sm text-gray-400">{t('customers.customsBroker')}</p>
                <p className="font-medium">{customer.customsBroker}</p>
              </div>
            )}
            {customer.qualityApprovalStatus && (
              <div className="p-3 bg-gray-50 rounded-lg">
                <p className="text-sm text-gray-400">{t('customers.qualityApprovalStatus')}</p>
                <Badge variant={customer.qualityApprovalStatus === 'Approved' ? 'default' : customer.qualityApprovalStatus === 'Rejected' ? 'destructive' : 'secondary'}>
                  {customer.qualityApprovalStatus}
                </Badge>
              </div>
            )}
          </div>

          {customer.businessDescription && (
            <div>
              <h4 className="font-medium mb-2">{t('customers.businessDescription')}</h4>
              <p className="text-sm text-gray-600 bg-gray-50 p-3 rounded-lg">{customer.businessDescription}</p>
            </div>
          )}

          {customer.contacts && customer.contacts.length > 0 && (
            <div>
              <h4 className="font-medium mb-3">{t('customers.contacts')}</h4>
              <div className="border rounded-lg overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('customers.contactName')}</TableHead>
                      <TableHead>{t('customers.email')}</TableHead>
                      <TableHead>{t('customers.phone')}</TableHead>
                      <TableHead>{t('customers.role')}</TableHead>
                      <TableHead>{t('customers.isDefault')}</TableHead>
                      <TableHead>RFQ</TableHead>
                      <TableHead>PO</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {customer.contacts.map((ct) => (
                      <TableRow key={ct.id}>
                        <TableCell className="font-medium">{ct.name}</TableCell>
                        <TableCell className="text-sm">{ct.email}</TableCell>
                        <TableCell>{ct.phone || '-'}</TableCell>
                        <TableCell>
                          <Badge variant="outline">
                            {ct.role === 'purchaser' && t('customers.rolePurchaser')}
                            {ct.role === 'quality_manager' && t('customers.roleQuality')}
                            {ct.role === 'engineering_manager' && t('customers.roleEngineering')}
                            {ct.role === 'logistics' && t('customers.roleEngineering')}
                            {ct.role === 'gm' && t('customers.roleGM')}
                          </Badge>
                        </TableCell>
                        <TableCell>{ct.isDefault ? <CheckCircle className="w-4 h-4 text-green-500" /> : '-'}</TableCell>
                        <TableCell>{ct.receiveRFQ ? <CheckCircle className="w-4 h-4 text-green-500" /> : '-'}</TableCell>
                        <TableCell>{ct.receivePO ? <CheckCircle className="w-4 h-4 text-green-500" /> : '-'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}

          {customer.competitorListings && customer.competitorListings.length > 0 && (
            <div>
              <h4 className="font-medium mb-3">{t('customers.competitorListings')}</h4>
              <div className="border rounded-lg overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('customers.competitorName')}</TableHead>
                      <TableHead>{t('customers.advantageParts')}</TableHead>
                      <TableHead>{t('customers.priceLevel')}</TableHead>
                      <TableHead>{t('customers.notes')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {customer.competitorListings.map((cl) => (
                      <TableRow key={cl.id}>
                        <TableCell className="font-medium">{cl.competitorName}</TableCell>
                        <TableCell>{cl.advantageParts || '-'}</TableCell>
                        <TableCell>
                          {cl.priceLevel && (
                            <Badge variant={cl.priceLevel === 'High' ? 'destructive' : cl.priceLevel === 'Low' ? 'default' : 'secondary'}>
                              {cl.priceLevel}
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-sm">{cl.notes || '-'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}

          {customer.decisionMakers && customer.decisionMakers.length > 0 && (
            <div>
              <h4 className="font-medium mb-3">{t('customers.decisionChain')}</h4>
              <div className="space-y-3">
                {customer.decisionMakers.map((dm) => (
                  <div key={dm.id} className="p-3 bg-gray-50 rounded-lg">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-medium">{dm.name}</p>
                        <p className="text-sm text-gray-500">{dm.title}</p>
                      </div>
                      <Badge variant="outline">
                        {dm.role === 'purchaser' && t('customers.rolePurchaser')}
                        {dm.role === 'quality_manager' && t('customers.roleQuality')}
                        {dm.role === 'engineering_manager' && t('customers.roleEngineering')}
                        {dm.role === 'gm' && t('customers.roleGM')}
                      </Badge>
                    </div>
                    {dm.concerns && dm.concerns.length > 0 && (
                      <div className="mt-2">
                        <p className="text-sm text-gray-500">
                          {t('customers.concerns')}: {Array.isArray(dm.concerns) ? dm.concerns.join(', ') : dm.concerns}
                        </p>
                        {dm.vetoItems && dm.vetoItems.length > 0 && (
                          <p className="text-sm text-red-500 mt-1">
                            {t('customers.veto')}: {Array.isArray(dm.vetoItems) ? dm.vetoItems.join(', ') : dm.vetoItems}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div>
            <h4 className="font-medium mb-3">{t('customers.transactionStats')}</h4>
            <div className="grid grid-cols-3 gap-4">
              <div className="p-4 bg-gray-50 rounded-lg text-center">
                <p className="text-2xl font-bold">{totalQuotes}</p>
                <p className="text-sm text-gray-500">{t('customers.totalQuotes')}</p>
              </div>
              <div className="p-4 bg-green-50 rounded-lg text-center">
                <p className="text-2xl font-bold text-green-600">{acceptedQuotes}</p>
                <p className="text-sm text-gray-500">{t('customers.closedDeals')}</p>
              </div>
              <div className="p-4 bg-blue-50 rounded-lg text-center">
                <p className="text-2xl font-bold text-blue-600">${totalRevenue.toLocaleString()}</p>
                <p className="text-sm text-gray-500">{t('customers.totalRevenue')}</p>
              </div>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('customers.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CustomerFormDialog({
  customer,
  isOpen,
  onClose,
  onSave,
}: {
  customer: Customer | null;
  isOpen: boolean;
  onClose: () => void;
  onSave: () => void;
}) {
  const { t } = useTranslation();
  const [formData, setFormData] = useState({
    name: customer?.name || '',
    contactName: customer?.contactName || '',
    email: customer?.email || '',
    phone: customer?.phone || '',
    buyerType: customer?.buyerType || 'End User',
    businessDescription: customer?.businessDescription || '',
    registeredAddress: customer?.registeredAddress || '',
    shipToAddress: customer?.shipToAddress || '',
    shipForAddress: customer?.shipForAddress || '',
    shippingContactName: customer?.shippingContactName || '',
    shippingContactPhone: customer?.shippingContactPhone || '',
    creditLimit: customer?.creditLimit?.toString() || '',
    creditRating: customer?.creditRating || '',
    paymentTerms: customer?.paymentTerms || '',
    paymentMethod: customer?.paymentMethod || '',
    annualRevenue: customer?.annualRevenue?.toString() || '',
    vatNumber: customer?.vatNumber || '',
    iataCode: customer?.iataCode || '',
    icaoCode: customer?.icaoCode || '',
    aocNumber: customer?.aocNumber || '',
    preferredIncoterm: customer?.preferredIncoterm || '',
    customsBroker: customer?.customsBroker || '',
    qualityApprovalStatus: customer?.qualityApprovalStatus || 'Pending',
    status: customer?.status || 'active',
  });
  const [contacts, setContacts] = useState<Partial<CustomerContact>[]>(
    customer?.contacts?.map((c) => ({ ...c })) || []
  );
  const [competitorListings, setCompetitorListings] = useState<Partial<CompetitorListing>[]>(
    customer?.competitorListings?.map((c) => ({ ...c })) || []
  );
  const [saving, setSaving] = useState(false);

  const handleSubmit = async () => {
    setSaving(true);
    try {
      const data = {
        ...formData,
        creditLimit: parseFloat(formData.creditLimit) || 0,
        annualRevenue: parseFloat(formData.annualRevenue) || 0,
        contacts: contacts.length > 0 ? contacts.map((c) => ({
          name: c.name || '',
          email: c.email || '',
          phone: c.phone,
          role: c.role || 'purchaser',
          isDefault: c.isDefault ?? false,
          receiveRFQ: c.receiveRFQ ?? false,
          receivePO: c.receivePO ?? false,
        })) : undefined,
        competitorListings: competitorListings.length > 0 ? competitorListings.map((c) => ({
          competitorName: c.competitorName || '',
          advantageParts: c.advantageParts,
          priceLevel: c.priceLevel,
          notes: c.notes,
        })) : undefined,
      };

      if (customer) {
        await customerApi.update(customer.id, data);
      } else {
        await customerApi.create(data);
      }
      onSave();
      onClose();
    } catch {
      toast.error(t('customers.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const addContact = () => {
    setContacts([...contacts, { name: '', email: '', phone: '', role: 'purchaser', isDefault: false, receiveRFQ: false, receivePO: false }]);
  };

  const removeContact = (index: number) => {
    setContacts(contacts.filter((_, i) => i !== index));
  };

  const updateContact = (index: number, field: keyof CustomerContact, value: unknown) => {
    const updated = [...contacts];
    updated[index] = { ...updated[index], [field]: value };
    setContacts(updated);
  };

  const addCompetitor = () => {
    setCompetitorListings([...competitorListings, { competitorName: '', advantageParts: '', priceLevel: 'Medium', notes: '' }]);
  };

  const removeCompetitor = (index: number) => {
    setCompetitorListings(competitorListings.filter((_, i) => i !== index));
  };

  const updateCompetitor = (index: number, field: keyof CompetitorListing, value: unknown) => {
    const updated = [...competitorListings];
    updated[index] = { ...updated[index], [field]: value };
    setCompetitorListings(updated);
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {customer ? t('customers.editTitle') : t('customers.addTitle')}
          </DialogTitle>
          <DialogDescription className="sr-only">{customer ? t('customers.editDescription') : t('customers.addDescription')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Basic Info */}
          <div className="space-y-4">
            <h4 className="font-medium text-sm text-gray-500 uppercase tracking-wider">{t('customers.customerName')}</h4>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{t('customers.nameRequired')}</Label>
                <Input
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder={t('customers.namePlaceholder')}
                />
              </div>
              <div className="space-y-2">
                <Label>{t('customers.buyerType')}</Label>
                <Select
                  value={formData.buyerType}
                  onValueChange={(v) => setFormData({ ...formData, buyerType: v as BuyerType })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {buyerTypeOptions.map((opt) => (
                      <SelectItem key={opt} value={opt}>
                        {opt}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{t('customers.contactRequired')}</Label>
                <Input
                  value={formData.contactName}
                  onChange={(e) => setFormData({ ...formData, contactName: e.target.value })}
                  placeholder={t('customers.contactPlaceholder')}
                />
              </div>
              <div className="space-y-2">
                <Label>{t('customers.email')}</Label>
                <Input
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  placeholder={t('customers.emailPlaceholder')}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{t('customers.phone')}</Label>
                <Input
                  value={formData.phone}
                  onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                  placeholder={t('customers.phonePlaceholder')}
                />
              </div>
              <div className="space-y-2">
                <Label>{t('customers.vatNumber')}</Label>
                <Input
                  value={formData.vatNumber}
                  onChange={(e) => setFormData({ ...formData, vatNumber: e.target.value })}
                  placeholder="VAT Number"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>{t('customers.businessDescription')}</Label>
              <Textarea
                value={formData.businessDescription}
                onChange={(e) => setFormData({ ...formData, businessDescription: e.target.value })}
                placeholder="Business description..."
                rows={3}
              />
            </div>
          </div>

          {/* Addresses */}
          <div className="space-y-4">
            <h4 className="font-medium text-sm text-gray-500 uppercase tracking-wider">{t('customers.address')}</h4>
            <div className="space-y-2">
              <Label>{t('customers.registeredAddress')}</Label>
              <Input
                value={formData.registeredAddress}
                onChange={(e) => setFormData({ ...formData, registeredAddress: e.target.value })}
                placeholder={t('customers.addressPlaceholder')}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{t('customers.shipToAddress')}</Label>
                <Input
                  value={formData.shipToAddress}
                  onChange={(e) => setFormData({ ...formData, shipToAddress: e.target.value })}
                  placeholder="Ship To Address"
                />
              </div>
              <div className="space-y-2">
                <Label>{t('customers.shipForAddress')}</Label>
                <Input
                  value={formData.shipForAddress}
                  onChange={(e) => setFormData({ ...formData, shipForAddress: e.target.value })}
                  placeholder="Ship For Address"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{t('customers.shippingContactName')}</Label>
                <Input
                  value={formData.shippingContactName}
                  onChange={(e) => setFormData({ ...formData, shippingContactName: e.target.value })}
                  placeholder="Shipping Contact Name"
                />
              </div>
              <div className="space-y-2">
                <Label>{t('customers.shippingContactPhone')}</Label>
                <Input
                  value={formData.shippingContactPhone}
                  onChange={(e) => setFormData({ ...formData, shippingContactPhone: e.target.value })}
                  placeholder="Shipping Contact Phone"
                />
              </div>
            </div>
          </div>

          {/* Financial & Compliance */}
          <div className="space-y-4">
            <h4 className="font-medium text-sm text-gray-500 uppercase tracking-wider">{t('customers.creditLimit')}</h4>
            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>{t('customers.creditLimit')}</Label>
                <Input
                  type="number"
                  value={formData.creditLimit}
                  onChange={(e) => setFormData({ ...formData, creditLimit: e.target.value })}
                  placeholder="0"
                />
              </div>
              <div className="space-y-2">
                <Label>{t('customers.creditRating')}</Label>
                <Select
                  value={formData.creditRating || undefined}
                  onValueChange={(v) => setFormData({ ...formData, creditRating: v === '_none' ? '' : v })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="-" />
                  </SelectTrigger>
                  <SelectContent>
                    {creditRatingOptions.map((opt) => (
                      <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>{t('customers.annualPurchase')}</Label>
                <Input
                  type="number"
                  value={formData.annualRevenue}
                  onChange={(e) => setFormData({ ...formData, annualRevenue: e.target.value })}
                  placeholder="0"
                />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>{t('customers.paymentTerms')}</Label>
                <Input
                  value={formData.paymentTerms}
                  onChange={(e) => setFormData({ ...formData, paymentTerms: e.target.value })}
                  placeholder={t('customers.paymentTermsPlaceholder')}
                />
              </div>
              <div className="space-y-2">
                <Label>{t('customers.paymentMethod')}</Label>
                <Input
                  value={formData.paymentMethod}
                  onChange={(e) => setFormData({ ...formData, paymentMethod: e.target.value })}
                  placeholder="e.g. Wire Transfer"
                />
              </div>
              <div className="space-y-2">
                <Label>{t('customers.qualityApprovalStatus')}</Label>
                <Select
                  value={formData.qualityApprovalStatus}
                  onValueChange={(v) => setFormData({ ...formData, qualityApprovalStatus: v as 'Pending' | 'Approved' | 'Rejected' })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {qualityApprovalOptions.map((opt) => (
                      <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          {/* Aviation Codes */}
          <div className="space-y-4">
            <h4 className="font-medium text-sm text-gray-500 uppercase tracking-wider">{t('customers.iataCode')}</h4>
            <div className="grid grid-cols-4 gap-4">
              <div className="space-y-2">
                <Label>{t('customers.iataCode')}</Label>
                <Input
                  value={formData.iataCode}
                  onChange={(e) => setFormData({ ...formData, iataCode: e.target.value })}
                  placeholder="IATA"
                />
              </div>
              <div className="space-y-2">
                <Label>{t('customers.icaoCode')}</Label>
                <Input
                  value={formData.icaoCode}
                  onChange={(e) => setFormData({ ...formData, icaoCode: e.target.value })}
                  placeholder="ICAO"
                />
              </div>
              <div className="space-y-2">
                <Label>{t('customers.aocNumber')}</Label>
                <Input
                  value={formData.aocNumber}
                  onChange={(e) => setFormData({ ...formData, aocNumber: e.target.value })}
                  placeholder="AOC Number"
                />
              </div>
              <div className="space-y-2">
                <Label>{t('customers.preferredIncoterm')}</Label>
                <Input
                  value={formData.preferredIncoterm}
                  onChange={(e) => setFormData({ ...formData, preferredIncoterm: e.target.value })}
                  placeholder="e.g. EXW"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>{t('customers.customsBroker')}</Label>
              <Input
                value={formData.customsBroker}
                onChange={(e) => setFormData({ ...formData, customsBroker: e.target.value })}
                placeholder="Customs Broker"
              />
            </div>
          </div>

          {/* Status */}
          {customer && (
            <div className="space-y-2">
              <Label>{t('customers.status')}</Label>
              <Tabs
                value={formData.status}
                onValueChange={(v) => setFormData({ ...formData, status: v as CustomerStatus })}
              >
                <TabsList>
                  <TabsTrigger value="active">{t('customers.active')}</TabsTrigger>
                  <TabsTrigger value="inactive">{t('customers.inactive')}</TabsTrigger>
                  <TabsTrigger value="at_risk">{t('customers.atRiskTab')}</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
          )}

          {/* Contacts Table */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="font-medium text-sm text-gray-500 uppercase tracking-wider">{t('customers.contacts')}</h4>
              <Button type="button" variant="outline" size="sm" onClick={addContact}>
                <Plus className="w-4 h-4 mr-1" />
                {t('customers.addContact')}
              </Button>
            </div>
            {contacts.length > 0 && (
              <div className="border rounded-lg overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[120px]">{t('customers.contactName')}</TableHead>
                      <TableHead className="w-[140px]">{t('customers.email')}</TableHead>
                      <TableHead className="w-[100px]">{t('customers.phone')}</TableHead>
                      <TableHead className="w-[100px]">{t('customers.role')}</TableHead>
                      <TableHead className="w-[60px]">{t('customers.isDefault')}</TableHead>
                      <TableHead className="w-[60px]">RFQ</TableHead>
                      <TableHead className="w-[60px]">PO</TableHead>
                      <TableHead className="w-[50px]"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {contacts.map((ct, idx) => (
                      <TableRow key={idx}>
                        <TableCell>
                          <Input
                            value={ct.name || ''}
                            onChange={(e) => updateContact(idx, 'name', e.target.value)}
                            placeholder="Name"
                            className="h-8"
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            value={ct.email || ''}
                            onChange={(e) => updateContact(idx, 'email', e.target.value)}
                            placeholder="Email"
                            className="h-8"
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            value={ct.phone || ''}
                            onChange={(e) => updateContact(idx, 'phone', e.target.value)}
                            placeholder="Phone"
                            className="h-8"
                          />
                        </TableCell>
                        <TableCell>
                          <Select
                            value={ct.role || 'purchaser'}
                            onValueChange={(v) => updateContact(idx, 'role', v)}
                          >
                            <SelectTrigger className="h-8 w-[100px]">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {contactRoleOptions.map((opt) => (
                                <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell>
                          <Checkbox
                            checked={ct.isDefault || false}
                            onCheckedChange={(v) => updateContact(idx, 'isDefault', !!v)}
                          />
                        </TableCell>
                        <TableCell>
                          <Checkbox
                            checked={ct.receiveRFQ || false}
                            onCheckedChange={(v) => updateContact(idx, 'receiveRFQ', !!v)}
                          />
                        </TableCell>
                        <TableCell>
                          <Checkbox
                            checked={ct.receivePO || false}
                            onCheckedChange={(v) => updateContact(idx, 'receivePO', !!v)}
                          />
                        </TableCell>
                        <TableCell>
                          <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={() => removeContact(idx)}>
                            <Trash2 className="w-4 h-4 text-red-500" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>

          {/* Competitor Listings Table */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="font-medium text-sm text-gray-500 uppercase tracking-wider">{t('customers.competitorListings')}</h4>
              <Button type="button" variant="outline" size="sm" onClick={addCompetitor}>
                <Plus className="w-4 h-4 mr-1" />
                {t('customers.addCompetitor')}
              </Button>
            </div>
            {competitorListings.length > 0 && (
              <div className="border rounded-lg overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[150px]">{t('customers.competitorName')}</TableHead>
                      <TableHead className="w-[150px]">{t('customers.advantageParts')}</TableHead>
                      <TableHead className="w-[100px]">{t('customers.priceLevel')}</TableHead>
                      <TableHead>{t('customers.notes')}</TableHead>
                      <TableHead className="w-[50px]"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {competitorListings.map((cl, idx) => (
                      <TableRow key={idx}>
                        <TableCell>
                          <Input
                            value={cl.competitorName || ''}
                            onChange={(e) => updateCompetitor(idx, 'competitorName', e.target.value)}
                            placeholder="Name"
                            className="h-8"
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            value={cl.advantageParts || ''}
                            onChange={(e) => updateCompetitor(idx, 'advantageParts', e.target.value)}
                            placeholder="Parts"
                            className="h-8"
                          />
                        </TableCell>
                        <TableCell>
                          <Select
                            value={cl.priceLevel || 'Medium'}
                            onValueChange={(v) => updateCompetitor(idx, 'priceLevel', v)}
                          >
                            <SelectTrigger className="h-8 w-[100px]">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {priceLevelOptions.map((opt) => (
                                <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell>
                          <Input
                            value={cl.notes || ''}
                            onChange={(e) => updateCompetitor(idx, 'notes', e.target.value)}
                            placeholder="Notes"
                            className="h-8"
                          />
                        </TableCell>
                        <TableCell>
                          <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={() => removeCompetitor(idx)}>
                            <Trash2 className="w-4 h-4 text-red-500" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('customers.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={saving || !formData.name || !formData.contactName}>
            {saving ? t('customers.saving') : t('customers.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function Customers() {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState('all');
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 10;
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);

  const { t, locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const dateLocale = locale === 'en' ? 'en-US' : 'zh-CN';
  const {
    data: customers,
    loading: customersLoading,
    pagination: customersPagination,
    summary: customersSummary,
    refetch: refetchCustomers,
  } = useCustomers({
    status: activeTab === 'all' ? undefined : activeTab,
    search: searchQuery,
    page: currentPage,
    limit: pageSize,
  });
  const customersList = customers || [];

  const filteredCustomers = customersList.filter((customer) => {
    if (searchQuery && !customer.name.toLowerCase().includes(searchQuery.toLowerCase()) &&
        !customer.contactName.toLowerCase().includes(searchQuery.toLowerCase())) {
      return false;
    }
    if (activeTab === 'all') return true;
    return customer.status === activeTab;
  });

  const totalRecords = customersPagination?.total ?? filteredCustomers.length;
  const totalPages = Math.max(1, customersPagination?.totalPages ?? Math.ceil(totalRecords / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const paginatedCustomers = filteredCustomers;

  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, activeTab]);

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  const stats = {
    total: customersSummary?.total ?? customersList.length,
    active: customersSummary?.active ?? customersList.filter((c) => c.status === 'active').length,
    atRisk: customersSummary?.atRisk ?? customersList.filter((c) => c.status === 'at_risk').length,
    inactive: customersSummary?.inactive ?? customersList.filter((c) => c.status === 'inactive').length,
    totalRevenue: customersSummary?.totalRevenue ?? customersList.reduce((sum, c) => sum + (c.annualRevenue || 0), 0),
  };

  const handleViewDetail = (customer: Customer) => {
    setSelectedCustomer(customer);
    setIsDetailOpen(true);
  };

  const handleEdit = (customer: Customer) => {
    setSelectedCustomer(customer);
    setIsEditOpen(true);
  };

  const handleAddNew = () => {
    setSelectedCustomer(null);
    setIsEditOpen(true);
  };

  if (customersLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="w-8 h-8 animate-spin text-brand-primary" />
        <span className="ml-2 text-gray-500">{t('customers.loading')}</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
        <Card className="hover:shadow-sm transition-shadow">
          <CardContent className="p-3 flex items-center gap-2">
            <Users className="w-4 h-4 text-gray-400" />
            <div>
              <p className="text-xs text-gray-500">{t('customers.totalCustomers')}</p>
              <p className="text-xl font-bold">{stats.total}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="hover:shadow-sm transition-shadow">
          <CardContent className="p-3 flex items-center gap-2">
            <CheckCircle className="w-4 h-4 text-green-500" />
            <div>
              <p className="text-xs text-gray-500">{t('customers.activeCustomers')}</p>
              <p className="text-xl font-bold text-green-600">{stats.active}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="hover:shadow-sm transition-shadow">
          <CardContent className="p-3 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-red-500" />
            <div>
              <p className="text-xs text-gray-500">{t('customers.atRisk')}</p>
              <p className="text-xl font-bold text-red-600">{stats.atRisk}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="hover:shadow-sm transition-shadow">
          <CardContent className="p-3 flex items-center gap-2">
            <Clock className="w-4 h-4 text-gray-400" />
            <div>
              <p className="text-xs text-gray-500">{t('customers.inactive')}</p>
              <p className="text-xl font-bold text-gray-500">{stats.inactive}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="hover:shadow-sm transition-shadow">
          <CardContent className="p-3 flex items-center gap-2">
            <DollarSign className="w-4 h-4 text-blue-500" />
            <div>
              <p className="text-xs text-gray-500">{t('customers.annualRevenue')}</p>
              <p className="text-xl font-bold">${stats.totalRevenue.toLocaleString()}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <div className="flex-1 min-w-[300px] flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <Input
              placeholder={t('customers.searchPlaceholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
            />
          </div>
        </div>
        <Button className="bg-brand-primary hover:bg-brand-primary-hover" onClick={handleAddNew}>
          <Plus className="w-4 h-4 mr-1" />
          {t('customers.addCustomer')}
        </Button>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="all">{t('customers.all')}</TabsTrigger>
          <TabsTrigger value="active">{t('customers.active')}</TabsTrigger>
          <TabsTrigger value="at_risk">{t('customers.atRiskTab')}</TabsTrigger>
              <TabsTrigger value="inactive">{t('customers.inactive')}</TabsTrigger>
        </TabsList>

        <TabsContent value={activeTab} className="mt-4">
          <Card>
            <CardContent className="p-0 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('customers.customerName')}</TableHead>
                    <TableHead>{t('customers.buyerType')}</TableHead>
                    <TableHead>{t('customers.contactName')}</TableHead>
                    <TableHead>{t('customers.annualPurchase')}</TableHead>
                    <TableHead>{t('customers.creditLimit')}</TableHead>
                    <TableHead>{t('customers.status')}</TableHead>
                    <TableHead>{t('customers.lastOrder')}</TableHead>
                    <TableHead>{t('customers.actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredCustomers.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={8} className="text-center py-12 text-gray-500">
                        <Users className="w-16 h-16 mx-auto mb-4 text-gray-300" />
                        <p>{t('customers.noCustomers')}</p>
                      </TableCell>
                    </TableRow>
                  ) : (
                    paginatedCustomers.map((customer) => (
                      <TableRow key={customer.id} className="hover:bg-gray-50">
                        <TableCell className="font-medium">
                          <div className="flex flex-col">
                            <span>{customer.name}</span>
                            {customer.registeredAddress && (
                              <span className="text-xs text-gray-400">{customer.registeredAddress}</span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <BuyerTypeBadge type={customer.buyerType} />
                        </TableCell>
                        <TableCell>{customer.contactName}</TableCell>
                        <TableCell>
                          <span className="text-blue-600 font-medium">
                            ${customer.annualRevenue?.toLocaleString() || '-'}
                          </span>
                        </TableCell>
                        <TableCell>${customer.creditLimit?.toLocaleString() || '-'}</TableCell>
                        <TableCell>
                          <CustomerStatusBadge status={customer.status} />
                        </TableCell>
                        <TableCell>
                          {customer.lastOrderDate
                            ? new Date(customer.lastOrderDate).toLocaleDateString(dateLocale)
                            : '-'}
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => handleViewDetail(customer)}
                            >
                              <Eye className="w-4 h-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => handleEdit(customer)}
                            >
                              <Edit3 className="w-4 h-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
              {totalPages > 1 && (
                <div className="flex items-center justify-between pt-2 px-4 pb-2">
                  <span className="text-sm text-gray-500">
                    {tx('第', 'Page')} {safePage} / {totalPages} {tx('页', '')}
                  </span>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" disabled={safePage <= 1} onClick={() => setCurrentPage(p => Math.max(1, p - 1))}>
                      <ChevronLeft className="w-4 h-4" />
                    </Button>
                    <Button variant="outline" size="sm" disabled={safePage >= totalPages} onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}>
                      <ChevronRight className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <CustomerDetailDialog
        customer={selectedCustomer}
        isOpen={isDetailOpen}
        onClose={() => {
          setIsDetailOpen(false);
          setSelectedCustomer(null);
        }}
      />

      <CustomerFormDialog
        customer={selectedCustomer}
        isOpen={isEditOpen}
        onClose={() => {
          setIsEditOpen(false);
          setSelectedCustomer(null);
        }}
        onSave={refetchCustomers}
      />
    </div>
  );
}
