"use client";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import Link from "next/link";
import { Suspense } from "react";
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
  { href: "/about", label: "About" },
  { href: "/notes", label: "Notes", requiresRole: "mdsusers" },
  { href: "/search", label: "Search", requiresRole: "mdsusers" },
  { href: "/chat", label: "Agent", requiresRole: "mdsusers" },
  { href: "/admin", label: "Admin", requiresRole: "mdsadmin" },
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

  if (pathname === "/about") {
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

function LayoutContent({ children, pathname, user, signIn, signOut, visibility = "public" }) {
  const buildNavHref = (href) => buildVisibilityHref(
    href,
    "",
    visibility,
    getNavAllowedVisibilityValues(href),
  );

  return (
    <div className={getPageSurfaceClassName(pathname)}>
      <header className="appChrome">
        <nav className="appNav">
          <div className="appNavBrandGroup">
            <Link href={buildNavHref("/")} className="appBrandLink">MDS</Link>
            <div className="appNavLinks">
              {navLinks.map((link) => {
                if (link.requiresRole && !hasClientPrincipalRole(user, link.requiresRole)) {
                  return null;
                }

                const isActive = pathname === link.href;

                return (
                  <Link
                    key={link.href}
                    href={buildNavHref(link.href)}
                    className={`appNavLink ${isActive ? "appNavLinkActive" : ""}`.trim()}
                  >
                    {link.label}
                  </Link>
                );
              })}
            </div>
          </div>

          <div className="appAuthGroup">
          {!user ? (
              <button onClick={signIn} className="appAuthButton appAuthButtonPrimary">Sign In</button>
          ) : (
            <>
                <span className="appAuthText">Welcome, {user.userDetails}!</span>
                <button onClick={signOut} className="appAuthButton appAuthButtonSecondary">Sign Out</button>
            </>
          )}
          </div>
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
