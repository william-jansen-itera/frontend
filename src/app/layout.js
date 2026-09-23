"use client";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import Image from "next/image";
import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useAuth } from "./useAuth";
import { hasClientPrincipalRole } from "@/shared/clientPrincipal";
import {
  ALL_VISIBILITY_VALUES,
  buildVisibilityHref,
  PUBLIC_PRIVATE_VISIBILITY_VALUES,
  usePersistedVisibility,
} from "./usePersistedVisibility";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const navLinks = [
  { href: "/notes", label: "Notes", requiresRole: "mdsusers" },
  { href: "/search", label: "Search", requiresRole: "mdsusers" },
  { href: "/chat", label: "Agent", requiresRole: "mdsusers" },
  { href: "/review", label: "Review", requiresAuthenticated: true },
  { href: "/me", label: "Me", requiresAuthenticated: true },
  { href: "/admin", label: "Admin", requiresRole: "mdsadmins" },
  { href: "/about", label: "About" },
  { href: "/contact", label: "Contact" },
  { href: "/architecture", label: "Architecture", requiresRole: "mdsadmins" },
];

function getPageSurfaceClassName(pathname) {
  if (pathname === "/notes") {
    return "appPageSurface appPageSurfaceNotes";
  }

  if (pathname === "/trees") {
    return "appPageSurface appPageSurfaceNotes";
  }

  if (pathname === "/chat") {
    return "appPageSurface appPageSurfaceChat";
  }

  if (pathname === "/search") {
    return "appPageSurface appPageSurfaceSearch";
  }

  if (pathname === "/review") {
    return "appPageSurface appPageSurfaceAbout";
  }

  if (pathname === "/about") {
    return "appPageSurface appPageSurfaceAbout";
  }

  if (pathname === "/contact") {
    return "appPageSurface appPageSurfaceAbout";
  }

  if (pathname === "/me") {
    return "appPageSurface appPageSurfaceAbout";
  }

  if (pathname === "/architecture") {
    return "appPageSurface appPageSurfaceAbout";
  }

  if (pathname === "/admin") {
    return "appPageSurface appPageSurfaceAbout";
  }

  return "appPageSurface appPageSurfaceHome";
}

function getNavAllowedVisibilityValues(href) {
  if (href === "/notes" || href === "/trees") {
    return PUBLIC_PRIVATE_VISIBILITY_VALUES;
  }

  return ALL_VISIBILITY_VALUES;
}

function HeaderAuthControls({
  user,
  signIn,
  signOut,
  mobile = false,
  onAction = null,
}) {
  const authGroupClassName = mobile ? "appAuthGroup appAuthGroupMobile" : "appAuthGroup";

  const handleSignIn = () => {
    onAction?.();
    signIn();
  };

  const handleSignOut = () => {
    onAction?.();
    signOut();
  };

  return (
    <div className={authGroupClassName}>
      {!user ? (
        <button onClick={handleSignIn} className="appAuthButton appAuthButtonPrimary">Sign In</button>
      ) : (
        <>
          <button onClick={handleSignOut} className="appAuthButton appAuthButtonSecondary">Sign Out</button>
        </>
      )}
    </div>
  );
}

function LayoutContent({ children, pathname, user, signIn, signOut, visibility = "public" }) {
  const [mobileMenuPathname, setMobileMenuPathname] = useState(null);
  const isMobileMenuOpen = mobileMenuPathname === pathname;

  const buildNavHref = (href) => buildVisibilityHref(
    href,
    "",
    visibility,
    getNavAllowedVisibilityValues(href),
  );

  const visibleNavLinks = navLinks.filter((link) => {
    if (link.requiresAuthenticated && !user) {
      return false;
    }

    if (link.requiresRole && !hasClientPrincipalRole(user, link.requiresRole)) {
      return false;
    }

    return true;
  });

  const renderNavLinks = ({ mobile = false } = {}) => {
    const className = mobile ? "appNavLinks appNavLinksMobile" : "appNavLinks";

    return (
      <div className={className}>
        {visibleNavLinks.map((link) => {
          const isActive = pathname === link.href;

          return (
            <Link
              key={link.href}
              href={buildNavHref(link.href)}
              className={`appNavLink ${isActive ? "appNavLinkActive" : ""}`.trim()}
              onClick={mobile ? () => setMobileMenuPathname(null) : undefined}
            >
              {link.label}
            </Link>
          );
        })}
      </div>
    );
  };

  return (
    <div className={getPageSurfaceClassName(pathname)}>
      <header className="appChrome">
        <nav className="appNav" aria-label="Primary">
          <div className="appNavMainRow">
            <div className="appNavBrandGroup">
              <Link href={buildNavHref("/")} className="appBrandLink" aria-label="MDS home">
                <Image
                  src="/MDS logo black heavier.png"
                  alt="MDS"
                  width={188}
                  height={60}
                  className="appBrandImage"
                  priority
                />
              </Link>
              {renderNavLinks()}
            </div>

            <button
              type="button"
              className="appNavMenuButton"
              aria-expanded={isMobileMenuOpen}
              aria-controls="app-mobile-menu"
              aria-label={isMobileMenuOpen ? "Close navigation menu" : "Open navigation menu"}
              onClick={() => setMobileMenuPathname((current) => (current === pathname ? null : pathname))}
            >
              <span className="appNavMenuButtonLine" />
              <span className="appNavMenuButtonLine" />
              <span className="appNavMenuButtonLine" />
            </button>
          </div>

          <HeaderAuthControls
            user={user}
            signIn={signIn}
            signOut={signOut}
          />

          {isMobileMenuOpen ? (
            <div id="app-mobile-menu" className="appMobileMenu">
              {renderNavLinks({ mobile: true })}
              <HeaderAuthControls
                user={user}
                signIn={signIn}
                signOut={signOut}
                mobile
                onAction={() => setMobileMenuPathname(null)}
              />
            </div>
          ) : null}
        </nav>
      </header>
      {children}
    </div>
  );
}

function LayoutContentWithVisibility({ children, user, signIn, signOut }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const requestedVisibilityParam = searchParams.get("visibility");
  const { visibility } = usePersistedVisibility({
    requestedVisibility: requestedVisibilityParam,
    allowedValues: ALL_VISIBILITY_VALUES,
  });

  return (
    <LayoutContent
      pathname={pathname}
      user={user}
      signIn={signIn}
      signOut={signOut}
      visibility={visibility}
    >
      {children}
    </LayoutContent>
  );
}

export default function RootLayout({ children }) {
  const { user, signIn, signOut } = useAuth();
  const pathname = usePathname();

  useEffect(() => {
    document.title = "MDS";
  }, []);

  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <Suspense fallback={(
          <LayoutContent
            pathname={pathname}
            user={user}
            signIn={signIn}
            signOut={signOut}
          >
            {children}
          </LayoutContent>
        )}
        >
          <LayoutContentWithVisibility
            user={user}
            signIn={signIn}
            signOut={signOut}
          >
            {children}
          </LayoutContentWithVisibility>
        </Suspense>
      </body>
    </html>
  );
}
