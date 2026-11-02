/**
 * Tailwind primitive kit — the MUI widgets this interface is built from,
 * rebuilt as thin class-based components. Call sites migrate one import at
 * a time: same names, same job, no `sx`, no theme lookups, no ripple.
 *
 * House rules for call sites:
 *
 *  - Styling goes through `className`. When a default must be overridden,
 *    use Tailwind's important prefix (`!h-[18px]`) so cascade order never
 *    decides between two same-property utilities.
 *  - Colours are theme tokens (`text-muted`, `bg-surface`, `border-line`,
 *    `bg-accent`, `text-disabled`, `text-action`, `bg-hover`) published on
 *    `<html>` by the ThemeProvider — dark mode and the live accent keep
 *    working through them.
 *  - MUI numeric spacing (n × 8px) becomes Tailwind n × 4px classes
 *    (`gap: 2` → `gap-4`); off-grid values take arbitrary px (`p: 0.75` →
 *    `p-[6px]`).
 *  - Numeric `borderRadius: n` was `n × 14px` (the old MUI theme's shape
 *    unit): `borderRadius: 1` → `rounded-card`, `borderRadius: 3` →
 *    `rounded-[42px]`.
 */
import {
  createContext,
  useContext,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ElementType,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import { AnimatePresence, motion } from 'framer-motion';

import { cn } from '../../utils/cn';

// One import surface: `../components/ui` re-exports the field and overlay
// kits so call sites never need to know which file a widget lives in.
export * from './Field';
export * from './Overlay';

/* ── Feedback ─────────────────────────────────────────────────────────── */

interface SpinnerProps {
  size?: number;
  /** `primary` is the live accent; `inherit` takes the surrounding colour. */
  color?: 'primary' | 'inherit';
  className?: string;
}

/** MUI `CircularProgress` — indeterminate ring, size in px. */
export function Spinner({ size = 40, color = 'primary', className }: SpinnerProps) {
  return (
    <span
      role="progressbar"
      className={cn(
        'inline-block animate-spin rounded-full border-current border-t-transparent',
        color === 'primary' && 'text-accent-fg',
        className,
      )}
      style={{ width: size, height: size, borderWidth: Math.max(2, Math.round(size / 9)) }}
    />
  );
}

interface ShimmerProps {
  variant?: 'text' | 'rounded' | 'circular';
  width?: number | string;
  height?: number | string;
  className?: string;
  style?: CSSProperties;
}

/** MUI `Skeleton` — pulsing placeholder block (`.skeleton` lives in styles.css). */
export function Shimmer({ variant = 'text', width, height, className, style }: ShimmerProps) {
  return (
    <span
      aria-hidden
      className={cn(
        'skeleton block',
        variant === 'circular' ? 'rounded-full' : variant === 'rounded' ? 'rounded-card' : 'rounded',
        variant === 'text' && !height && 'h-4',
        className,
      )}
      style={{ width, height, ...style }}
    />
  );
}

/** MUI `LinearProgress` (indeterminate) — the "still loading" bar. */
export function ProgressBar({ className }: { className?: string }) {
  return (
    <span
      role="progressbar"
      className={cn('progress-indeterminate block h-1 w-full rounded-full bg-hover', className)}
    >
      <i />
    </span>
  );
}

/* ── Buttons ──────────────────────────────────────────────────────────── */

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'color'> {
  /** MUI colour roles (default = `action.active`, like the element did). */
  color?: 'default' | 'primary' | 'error';
  size?: 'small' | 'medium';
  /** MUI's edge pull — `start` shifts the button 8px out of its row. */
  edge?: 'start' | 'end';
  children?: ReactNode;
}

/** MUI `IconButton` — round hover target, no ripple. */
export function IconButton({
  color = 'default',
  size = 'medium',
  edge,
  className,
  children,
  type = 'button',
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      {...rest}
      className={cn(
        'relative inline-grid place-items-center rounded-full transition-colors duration-150',
        'text-action hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent',
        'disabled:pointer-events-none disabled:text-disabled',
        color === 'primary' && 'text-accent-fg',
        color === 'error' && 'text-error',
        size === 'small' ? 'p-[5px]' : 'p-2',
        edge === 'start' && '-ml-2',
        edge === 'end' && '-mr-2',
        className,
      )}
    >
      {children}
    </button>
  );
}

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'color'> {
  /** The two variants call sites use; `outlined` never appears. */
  variant?: 'text' | 'contained';
  color?: 'primary' | 'error';
  fullWidth?: boolean;
  startIcon?: ReactNode;
  endIcon?: ReactNode;
  children?: ReactNode;
}

/** MUI `Button` — pill button on the 0.875rem/600 button typography. */
export function Button({
  variant = 'text',
  color = 'primary',
  fullWidth,
  startIcon,
  endIcon,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      {...rest}
      className={cn(
        'relative inline-flex select-none items-center justify-center gap-2 rounded-full px-4 py-1.5',
        'text-sm font-semibold leading-6 transition-colors duration-150',
        'focus-visible:outline-2 focus-visible:outline-accent',
        'disabled:pointer-events-none disabled:opacity-50',
        variant === 'contained'
          ? color === 'error'
            ? 'bg-error text-white hover:brightness-90'
            : 'bg-accent text-accent-contrast hover:brightness-90'
          : color === 'error'
            ? 'text-error hover:bg-hover'
            : 'text-accent-fg hover:bg-hover',
        fullWidth && 'w-full',
        className,
      )}
    >
      {startIcon ? <span className="-ml-1 inline-flex">{startIcon}</span> : null}
      {children}
      {endIcon ? <span className="-mr-1 inline-flex">{endIcon}</span> : null}
    </button>
  );
}

/** MUI `Fab` — floating round button (size/glow come from call-site classes). */
export function Fab({
  className,
  children,
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      {...rest}
      className={cn(
        'relative inline-grid place-items-center rounded-full bg-accent text-accent-contrast',
        'transition-[transform,box-shadow] duration-150',
        'focus-visible:outline-2 focus-visible:outline-accent',
        'disabled:pointer-events-none disabled:opacity-50',
        className,
      )}
    >
      {children}
    </button>
  );
}

/* ── Data display ─────────────────────────────────────────────────────── */

interface TooltipProps {
  title: ReactNode;
  placement?: 'top' | 'bottom' | 'left' | 'right';
  children: ReactNode;
}

/**
 * MUI `Tooltip` — dark bubble on hover/focus, rendered inline (a portal is
 * not needed at the placements call sites use).
 */
export function Tooltip({ title, placement = 'top', children }: TooltipProps) {
  const position =
    placement === 'bottom'
      ? 'top-full mt-1.5'
      : placement === 'left'
        ? 'right-full mr-1.5'
        : placement === 'right'
          ? 'left-full ml-1.5'
          : 'bottom-full mb-1.5';
  const center = placement === 'top' || placement === 'bottom' ? 'left-1/2 -translate-x-1/2' : 'top-1/2 -translate-y-1/2';

  return (
    <span className="group/tooltip relative inline-flex">
      {children}
      {title ? (
        <span
          role="tooltip"
          className={cn(
            'pointer-events-none absolute z-50 whitespace-nowrap rounded-md bg-neutral-800 px-2 py-1',
            'text-xs leading-4 text-neutral-50 opacity-0 shadow-md transition-opacity duration-150',
            'group-hover/tooltip:opacity-100 group-focus-within/tooltip:opacity-100',
            position,
            center,
          )}
        >
          {title}
        </span>
      ) : null}
    </span>
  );
}

interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  label: ReactNode;
  size?: 'small' | 'medium';
  variant?: 'outlined' | 'filled';
  children?: ReactNode;
}

/** MUI `Chip` — small pill (label/status badge). */
export function Chip({ label, size = 'medium', variant = 'filled', className, ...rest }: ChipProps) {
  return (
    <span
      {...rest}
      className={cn(
        'inline-flex items-center justify-center gap-1 rounded-full px-2 text-xs font-medium',
        size === 'small' ? 'h-6 text-[0.6875rem]' : 'h-8',
        variant === 'outlined'
          ? 'border border-line text-muted'
          : 'bg-hover text-muted',
        className,
      )}
    >
      {label}
    </span>
  );
}

interface DividerProps extends HTMLAttributes<any> {
  /** `li` so a divider can sit directly inside a `List`. */
  component?: 'hr' | 'li' | 'div';
  /** MUI's inset indents 72px (past a row avatar); middle adds 16px sides. */
  variant?: 'fullWidth' | 'inset' | 'middle';
  orientation?: 'horizontal' | 'vertical';
}

/** MUI `Divider` — hairline rule. */
export function Divider({
  component: Comp = 'hr',
  variant = 'fullWidth',
  orientation = 'horizontal',
  className,
  ...rest
}: DividerProps) {
  const inset = variant === 'inset' && orientation === 'horizontal';
  const middle = variant === 'middle';
  return (
    <Comp
      {...rest}
      role="separator"
      aria-orientation={orientation}
      className={cn(
        'border-0 border-line',
        orientation === 'vertical' ? 'w-px self-stretch border-r' : 'border-t',
        // A horizontal divider is a block: its width must subtract the
        // indent it carries, else `w-full` + margin spills past the list
        // container — the classic hidden-horizontal-overflow bug.
        inset && 'ml-[72px] w-[calc(100%_-_72px)]',
        middle && 'mx-4 w-[calc(100%_-_32px)]',
        !inset && !middle && orientation === 'horizontal' && 'w-full',
        className,
      )}
    />
  );
}

/* ── Layout ───────────────────────────────────────────────────────────── */

interface ContainerProps extends HTMLAttributes<HTMLDivElement> {
  /** MUI container steps: sm = 600px, md = 900px, lg = 1200px. */
  maxWidth?: 'sm' | 'md' | 'lg';
  children?: ReactNode;
}

/** MUI `Container` — centred page column with the stock gutters. */
export function Container({ maxWidth = 'lg', className, children, ...rest }: ContainerProps) {
  return (
    <div
      {...rest}
      className={cn(
        'mx-auto w-full px-4 md:px-6',
        maxWidth === 'sm' && 'max-w-[600px]',
        maxWidth === 'md' && 'max-w-[900px]',
        maxWidth === 'lg' && 'max-w-[1200px]',
        className,
      )}
    >
      {children}
    </div>
  );
}

interface PaperProps extends HTMLAttributes<HTMLDivElement> {
  variant?: 'elevation' | 'outlined';
  children?: ReactNode;
}

/** MUI `Paper` — surface card (`outlined` draws the border, elevation never showed here). */
export function Paper({ variant = 'elevation', className, children, ...rest }: PaperProps) {
  return (
    <div
      {...rest}
      className={cn(
        'bg-surface',
        variant === 'outlined' && 'border border-line',
        className,
      )}
    >
      {children}
    </div>
  );
}

/* ── Lists ────────────────────────────────────────────────────────────── */

interface ListProps extends HTMLAttributes<HTMLUListElement> {
  /** MUI `dense` tightens row padding; `disablePadding` drops the 8px block. */
  dense?: boolean;
  disablePadding?: boolean;
  children?: ReactNode;
}

/** MUI `List` — `<ul>` shell. */
export function List({ dense, disablePadding, className, children, ...rest }: ListProps) {
  return (
    <ul
      {...rest}
      className={cn('m-0 list-none p-0', !disablePadding && (dense ? 'py-1' : 'py-2'), className)}
    >
      {children}
    </ul>
  );
}

interface ListItemProps extends HTMLAttributes<HTMLLIElement> {
  disablePadding?: boolean;
  children?: ReactNode;
}

/** MUI `ListItem` — `<li>` row. */
export function ListItem({ disablePadding, className, children, ...rest }: ListItemProps) {
  return (
    <li {...rest} className={cn(!disablePadding && 'py-2', className)}>
      {children}
    </li>
  );
}

interface ListItemButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'color'> {
  /** Polymorphic target — `as={NavLink}` keeps the router link behaviour. */
  as?: ElementType;
  selected?: boolean;
  /** Router target when `as` is a `NavLink`. */
  to?: string;
  children?: ReactNode;
}

/** MUI `ListItemButton` — interactive row (hover + selected states). */
export function ListItemButton({
  as: Comp = 'button',
  selected,
  className,
  children,
  type,
  ...rest
}: ListItemButtonProps) {
  const isNativeButton = Comp === 'button';
  return (
    <Comp
      {...rest}
      {...(isNativeButton ? { type: type ?? 'button' } : null)}
      className={cn(
        'flex w-full items-center gap-4 rounded-lg px-3 py-2 text-left',
        'transition-colors duration-150 hover:bg-hover',
        'focus-visible:outline-2 focus-visible:outline-accent',
        'disabled:pointer-events-none disabled:opacity-50',
        selected && 'bg-hover text-accent-fg',
        className,
      )}
    >
      {children}
    </Comp>
  );
}

interface ListItemTextProps extends HTMLAttributes<HTMLDivElement> {
  primary: ReactNode;
  /** Second line (menus/search suggestions). */
  secondary?: ReactNode;
  /** Class for the primary line — replaces `primaryTypographyProps`. */
  primaryClassName?: string;
  secondaryClassName?: string;
}

/** MUI `ListItemText` — one or two text lines. */
export function ListItemText({
  primary,
  secondary,
  primaryClassName,
  secondaryClassName,
  className,
  ...rest
}: ListItemTextProps) {
  return (
    <div {...rest} className={cn('min-w-0 flex-1', className)}>
      <div className={cn('truncate text-sm font-semibold', primaryClassName)}>{primary}</div>
      {secondary != null ? (
        <div className={cn('truncate text-xs text-muted', secondaryClassName)}>{secondary}</div>
      ) : null}
    </div>
  );
}

/** MUI `ListSubheader` — section caption inside a list (transparent by default). */
export function ListSubheader({ className, children, ...rest }: HTMLAttributes<HTMLLIElement>) {
  return (
    <li {...rest} className={cn('px-2 pb-1 pt-2 text-xs font-semibold text-muted', className)}>
      {children}
    </li>
  );
}

interface CollapseProps {
  in: boolean;
  children: ReactNode;
  className?: string;
  /** Kept for signature parity; framer unmounts after the exit animation. */
  timeout?: 'auto' | number;
  unmountOnExit?: boolean;
}

/** MUI `Collapse` — framer height/opacity expand-contract. */
export function Collapse({ in: open, children, className }: CollapseProps) {
  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.25, ease: 'easeInOut' }}
          style={{ overflow: 'hidden' }}
          className={className}
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

/* ── Navigation ───────────────────────────────────────────────────────── */

interface TabsContextValue {
  value: unknown;
  onChange: (value: never) => void;
  variant: 'standard' | 'fullWidth' | 'scrollable';
}

const TabsContext = createContext<TabsContextValue | null>(null);

interface TabsProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> {
  value: unknown;
  onChange: (value: unknown) => void;
  /** `fullWidth` spreads tabs, `scrollable` lets them overflow horizontally. */
  variant?: 'standard' | 'fullWidth' | 'scrollable';
  'aria-label'?: string;
  children?: ReactNode;
}

/** MUI `Tabs` — tab strip; underline styling comes from each `Tab`. */
export function Tabs({
  value,
  onChange,
  variant = 'standard',
  className,
  children,
  ...rest
}: TabsProps) {
  return (
    <TabsContext.Provider value={{ value, onChange: onChange as TabsContextValue['onChange'], variant }}>
      <div
        role="tablist"
        {...rest}
        className={cn(
          'flex items-stretch',
          variant === 'scrollable' && 'overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
          variant === 'fullWidth' && 'w-full',
          className,
        )}
      >
        {children}
      </div>
    </TabsContext.Provider>
  );
}

interface TabProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'value' | 'onChange'> {
  value: unknown;
  label: ReactNode;
  icon?: ReactNode;
  /** MUI parity — only `start` appears in the app. */
  iconPosition?: 'start' | 'end';
}

/** MUI `Tab` — one tab; reads its strip's context (no child cloning). */
export function Tab({
  value,
  label,
  icon,
  iconPosition = 'start',
  className,
  children,
  ...rest
}: TabProps) {
  const ctx = useContext(TabsContext);
  const selected = ctx?.value === value;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      {...rest}
      onClick={(event) => {
        rest.onClick?.(event);
        ctx?.onChange(value as never);
      }}
      className={cn(
        'relative flex shrink-0 items-center gap-1.5 whitespace-nowrap px-4 py-2.5',
        'text-sm font-medium transition-colors duration-150',
        'focus-visible:outline-2 focus-visible:outline-accent',
        'after:absolute after:inset-x-0 after:-bottom-px after:h-[2px] after:content-[""]',
        selected ? 'text-accent-fg after:bg-accent-fg' : 'text-muted hover:text-body after:bg-transparent',
        ctx?.variant === 'fullWidth' && 'flex-1 justify-center',
        className,
      )}
    >
      {icon && iconPosition === 'start' ? <span className="inline-flex">{icon}</span> : null}
      {children ?? label}
      {icon && iconPosition === 'end' ? <span className="inline-flex">{icon}</span> : null}
    </button>
  );
}
