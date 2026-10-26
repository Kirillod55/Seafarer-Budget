// One place for the app's icons (lucide-react): interface icons are re-exported by name, category glyphs by key.
import {
  Book,
  Car,
  Coffee,
  Dumbbell,
  FileText,
  Fuel,
  Gift,
  House,
  Package,
  Plane,
  Shirt,
  ShoppingCart,
  Smartphone,
  SquarePlus,
  Tag,
  Ticket,
  Wallet,
  Wifi,
  type LucideIcon,
} from 'lucide-react'

export type { LucideIcon }

export {
  Anchor,
  Archive,
  Bell,
  ArrowUp,
  Calendar,
  CalendarDays,
  ChartPie,
  Check,
  Copy,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  CreditCard,
  CircleAlert,
  Ellipsis,
  Eye,
  EyeOff,
  Gauge,
  House,
  Info,
  Landmark,
  LogOut,
  MonitorSmartphone,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Tag,
  Scale,
  Settings,
  Sun,
  Target,
  Trash2,
  Upload,
  UserRound,
  UsersRound,
  Download,
  Wallet,
  X,
} from 'lucide-react'

/**
 * Category glyphs (spec §6 «Иконки категорий»): outline icons drawn on a tile of the category colour.
 * Keys are the `glyph` values of categories (CATEGORY_STYLE in @shared/defaults.ts and the user's own choice).
 */
export const CATEGORY_GLYPHS: Record<string, LucideIcon> = {
  cart: ShoppingCart,
  coffee: Coffee,
  car: Car,
  home: House,
  wifi: Wifi,
  health: SquarePlus,
  ticket: Ticket,
  doc: FileText,
  gift: Gift,
  plane: Plane,
  shirt: Shirt,
  book: Book,
  fuel: Fuel,
  gym: Dumbbell,
  phone: Smartphone,
  wallet: Wallet,
  box: Package,
  tag: Tag,
}

/** The glyph for a key; an unknown key (e.g. from a newer app version) falls back to the tag. */
export function categoryGlyph(key: string): LucideIcon {
  return CATEGORY_GLYPHS[key] ?? Tag
}
