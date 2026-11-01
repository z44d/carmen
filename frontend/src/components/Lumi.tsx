import { useRef, type ReactNode } from 'react';

import { cn } from '../utils/cn';
import { ChevronLeftIcon, ChevronRightIcon, GitHubIcon } from './icons';

/**
 * Shared Lumi chrome: section headers, peek-scrolling rows and the
 * minimal footer. No data lives here — every action is passed in by the
 * page, so a header link is never decorative.
 */

/** Lumi section header: bold title left, optional real "See All" action right. */
export function SectionHeader({
  title,
  subtitle,
  seeAllLabel = 'See All',
  onSeeAll,
  action,
}: {
  title: string;
  subtitle?: ReactNode;
  seeAllLabel?: string;
  onSeeAll?: () => void;
  /** Extra header controls (e.g. shuffle) rendered left of See All. */
  action?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-end gap-3 px-4 md:px-10">
      <div className="min-w-0 flex-1">
        <h2 className="m-0 text-[19px] font-bold leading-tight tracking-[-0.01em] md:text-xl">
          {title}
        </h2>
        {subtitle ? (
          <span className="mt-0.5 block truncate text-[13px] leading-[1.4] text-muted">{subtitle}</span>
        ) : null}
      </div>
      {action}
      {onSeeAll ? (
        <button
          type="button"
          onClick={onSeeAll}
          aria-label={`${seeAllLabel}: ${title}`}
          className="flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded-full px-2 py-1.5 text-sm font-semibold text-muted transition-colors hover:text-body focus-visible:outline-2 focus-visible:outline-accent active:scale-[0.97]"
        >
          {seeAllLabel}
          <ChevronRightIcon fontSize="small" />
        </button>
      ) : null}
    </div>
  );
}

/**
 * Single horizontal peek-scrolling strip: the next card is cut off at the
 * right edge, scroll-snap keeps cards aligned, and a floating circular
 * chevron (desktop widths only) scrolls a page at a time in either
 * direction. Touch widths rely on swipe — the chevrons stay hidden there.
 */
export function RowStrip({
  children,
  label,
  className,
  onScroll,
}: {
  children: ReactNode;
  label: string;
  className?: string;
  onScroll?: (event: React.UIEvent<HTMLDivElement>) => void;
}) {
  const stripRef = useRef<HTMLDivElement | null>(null);

  const scrollByPage = (direction: 1 | -1) => {
    const node = stripRef.current;
    if (!node) return;
    node.scrollBy({ left: direction * node.clientWidth * 0.8, behavior: 'smooth' });
  };

  return (
    <div className={cn('group/strip relative', className)}>
      <div
        ref={stripRef}
        aria-label={label}
        onScroll={onScroll}
        className="lumi-row flex gap-3 overflow-x-auto px-4 pb-2 md:gap-5 md:px-10"
      >
        {children}
      </div>
      <button
        type="button"
        aria-label={`Scroll ${label} left`}
        onClick={() => scrollByPage(-1)}
        className="glass-pill absolute left-3 top-1/2 z-10 hidden size-11 -translate-y-1/2 place-items-center rounded-full opacity-0 shadow-glass transition-opacity duration-200 hover:brightness-125 focus-visible:opacity-100 group-hover/strip:opacity-100 md:grid"
      >
        <ChevronLeftIcon />
      </button>
      <button
        type="button"
        aria-label={`Scroll ${label} right`}
        onClick={() => scrollByPage(1)}
        className="glass-pill absolute right-3 top-1/2 z-10 hidden size-11 -translate-y-1/2 place-items-center rounded-full opacity-0 shadow-glass transition-opacity duration-200 hover:brightness-125 focus-visible:opacity-100 group-hover/strip:opacity-100 md:grid"
      >
        <ChevronRightIcon />
      </button>
    </div>
  );
}

const REPO_URL = 'https://github.com/z44d/carmen';

/** Minimal Lumi footer: brand + tagline left, one small credit right. */
export function LumiFooter() {
  return (
    <footer className="mt-10 border-t border-line md:mt-12">
      <div className="flex flex-col gap-3 px-4 py-7 sm:flex-row sm:items-center sm:justify-between md:px-10">
        <div className="min-w-0">
          <p className="m-0 text-[15px] font-bold tracking-tight">Carmen</p>
          <p className="m-0 mt-0.5 text-[13px] leading-[1.4] text-muted">Your music, everywhere.</p>
        </div>
        <a
          href={REPO_URL}
          target="_blank"
          rel="noreferrer"
          className="flex shrink-0 items-center gap-1.5 text-[13px] font-semibold text-muted no-underline transition-colors hover:text-body focus-visible:outline-2 focus-visible:outline-accent"
        >
          <GitHubIcon sx={{ fontSize: 16 }} />
          Carmen on GitHub
        </a>
      </div>
    </footer>
  );
}
