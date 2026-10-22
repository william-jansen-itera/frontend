"use client";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import Image from "next/image";
import Link from "next/link";
import { Suspense, useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import { AuthProvider, useAuth } from "./useAuth";
import { hasClientPrincipalRole } from "@/shared/clientPrincipal";
import { ADMIN_SECTIONS } from "./admin/adminShared";
import enMessages from "./language/en.json";
import daMessages from "./language/da.json";
import { usePersistedLanguage } from "./usePersistedLanguage";
import {
  ALL_VISIBILITY_VALUES,
  buildVisibilityHref,
  PUBLIC_PRIVATE_VISIBILITY_VALUES,
  usePersistedVisibility,
} from "./usePersistedVisibility";

const adminNavChildren = ADMIN_SECTIONS;

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const navLinks = [
  { href: "/notes", labelKey: "Notes", requiresRole: "mdsusers" },
  { href: "/search", labelKey: "Search", requiresRole: "mdsusers" },
  { href: "/chat", labelKey: "Agent", requiresRole: "mdsusers" },
  { href: "/review", labelKey: "Review", requiresRole: "mdsusers" },
  { href: "/me", labelKey: "Me", requiresAuthenticated: true },
  { href: "/admin", labelKey: "Admin", requiresRole: "mdsadmins", children: adminNavChildren },
  { href: "/about", labelKey: "About" },
  { href: "/contact", labelKey: "Contact" },
  { href: "/architecture", labelKey: "Architecture", requiresRole: "mdsadmins" },
];

const adminNavKeys = {
  "/admin/deletions": "DeletedItems",
  "/admin/agent-publishing": "AgentPublishing",
  "/admin/analytics": "Analytics",
  "/admin/indexing": "Indexing",
  "/admin/contact-requests": "ContactRequests",
};

function getPageSurfaceClassName(pathname) {
  if (pathname.startsWith("/admin")) {
    return "appPageSurface appPageSurfaceAbout";
  }

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
  return "appPageSurface appPageSurfaceHome";
}

function isNavLinkActive(pathname, href) {
  if (href === "/admin") {
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  return pathname === href;
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
  language,
  setLanguage,
  mobile = false,
  onAction = null,
}) {
  const t = useTranslations("Menu");
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
      <label className="appLanguageControl">
        <span>{t("LanguageLabel")}</span>
        <select value={language} onChange={(event) => setLanguage(event.target.value)}>
          <option value="en">English</option>
          <option value="da">Dansk</option>
        </select>
      </label>
      {!user ? (
        <button onClick={handleSignIn} className="appAuthButton appAuthButtonPrimary">{t("SignIn")}</button>
      ) : (
        <>
          <button onClick={handleSignOut} className="appAuthButton appAuthButtonSecondary">{t("SignOut")}</button>
        </>
      )}
    </div>
  );
}

function LayoutContent({ children, pathname, user, signIn, signOut, language, setLanguage, visibility = "public" }) {
  const t = useTranslations("Menu");
  const [mobileMenuPathname, setMobileMenuPathname] = useState(null);
  const [openNavGroupHref, setOpenNavGroupHref] = useState(null);
  const navRef = useRef(null);
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

  useEffect(() => {
    if (!openNavGroupHref) {
      return undefined;
    }

    const handlePointerDown = (event) => {
      if (!navRef.current?.contains(event.target)) {
        setOpenNavGroupHref(null);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [openNavGroupHref]);

  const renderNavLinks = ({ mobile = false } = {}) => {
    const className = mobile ? "appNavLinks appNavLinksMobile" : "appNavLinks";

    return (
      <div className={className}>
        {visibleNavLinks.map((link) => {
          const isActive = isNavLinkActive(pathname, link.href);

          if (Array.isArray(link.children) && link.children.length > 0) {
            const groupClassName = mobile ? "appNavGroup appNavGroupMobile" : "appNavGroup";
            const isGroupOpen = openNavGroupHref === link.href;
            const submenuClassName = [
              mobile ? "appNavSubmenu appNavSubmenuMobile" : "appNavSubmenu",
              isGroupOpen ? "appNavSubmenuOpen" : "",
            ].filter(Boolean).join(" ");
            const submenuId = `nav-submenu-${link.href.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase()}`;

            return (
              <div key={link.href} className={groupClassName}>
                <button
                  type="button"
                  className={`appNavLink appNavLinkButton appNavLinkWithChildren ${isActive || isGroupOpen ? "appNavLinkActive" : ""}`.trim()}
                  aria-expanded={isGroupOpen}
                  aria-controls={submenuId}
                  onClick={() => setOpenNavGroupHref((current) => (current === link.href ? null : link.href))}
                >
                  <span>{t(link.labelKey)}</span>
                  <span className="appNavLinkChevron" aria-hidden="true">▾</span>
                </button>

                <div id={submenuId} className={submenuClassName}>
                  {link.children.map((childLink) => {
                    const isChildActive = pathname === childLink.href;

                    return (
                      <Link
                        key={childLink.href}
                        href={buildNavHref(childLink.href)}
                        prefetch={false}
                        className={`appNavSubmenuLink ${isChildActive ? "appNavSubmenuLinkActive" : ""}`.trim()}
                        onClick={() => {
                          setOpenNavGroupHref(null);
                          if (mobile) {
                            setMobileMenuPathname(null);
                          }
                        }}
                      >
                        {adminNavKeys[childLink.href] ? t(adminNavKeys[childLink.href]) : childLink.label}
                      </Link>
                    );
                  })}
                </div>
              </div>
            );
          }

          return (
            <Link
              key={link.href}
              href={buildNavHref(link.href)}
              prefetch={false}
              className={`appNavLink ${isActive ? "appNavLinkActive" : ""}`.trim()}
              onClick={mobile ? () => setMobileMenuPathname(null) : undefined}
            >
              {t(link.labelKey)}
            </Link>
          );
        })}
      </div>
    );
  };

  return (
    <div className={getPageSurfaceClassName(pathname)}>
      <header className="appChrome">
        <nav ref={navRef} className="appNav" aria-label="Primary">
          <div className="appNavMainRow">
            <div className="appNavBrandGroup">
              <Link href={buildNavHref("/")} className="appBrandLink" aria-label={t("HomeLabel")}>
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

            <HeaderAuthControls
              user={user}
              signIn={signIn}
              signOut={signOut}
              language={language}
              setLanguage={setLanguage}
            />

            <button
              type="button"
              className="appNavMenuButton"
              aria-expanded={isMobileMenuOpen}
              aria-controls="app-mobile-menu"
              aria-label={isMobileMenuOpen ? t("CloseNavigation") : t("OpenNavigation")}
              onClick={() => setMobileMenuPathname((current) => (current === pathname ? null : pathname))}
            >
              <span className="appNavMenuButtonLine" />
              <span className="appNavMenuButtonLine" />
              <span className="appNavMenuButtonLine" />
            </button>
          </div>

          {isMobileMenuOpen ? (
            <div id="app-mobile-menu" className="appMobileMenu">
              {renderNavLinks({ mobile: true })}
              <HeaderAuthControls
                user={user}
                signIn={signIn}
                signOut={signOut}
                language={language}
                setLanguage={setLanguage}
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

function LayoutContentWithVisibility({ children, user, signIn, signOut, language, setLanguage }) {
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
      language={language}
      setLanguage={setLanguage}
      visibility={visibility}
    >
      {children}
    </LayoutContent>
  );
}

function RootLayoutShell({ children }) {
  const { user, signIn, signOut } = useAuth();
  const pathname = usePathname();
  const { language, setLanguage } = usePersistedLanguage();

  useEffect(() => {
    document.title = "MDS";
    document.documentElement.lang = language;
  }, [language]);

  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <NextIntlClientProvider locale={language} messages={language === "da" ? daMessages : enMessages} timeZone="UTC">
          <Suspense fallback={(
            <LayoutContent
              pathname={pathname}
              user={user}
              signIn={signIn}
              signOut={signOut}
              language={language}
              setLanguage={setLanguage}
            >
              {children}
            </LayoutContent>
          )}
          >
            <LayoutContentWithVisibility
              user={user}
              signIn={signIn}
              signOut={signOut}
              language={language}
              setLanguage={setLanguage}
            >
              {children}
            </LayoutContentWithVisibility>
          </Suspense>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}

export default function RootLayout({ children }) {
  return (
    <AuthProvider>
      <RootLayoutShell>{children}</RootLayoutShell>
    </AuthProvider>
  );
}
