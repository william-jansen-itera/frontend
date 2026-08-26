"use client";
import { useEffect, useState } from "react";
import {
  createLocalDevelopmentPrincipal,
  isLocalDevelopmentHost,
  normalizeClientPrincipal,
} from "@/shared/clientPrincipal";

export function useAuth() {
  const [user, setUser] = useState(null);

  useEffect(() => {
    let isCancelled = false;

    async function getUser() {
      const isLocal = typeof window !== 'undefined' && isLocalDevelopmentHost(window.location.hostname);

      if (isLocal) {
        if (!isCancelled) {
          setUser(normalizeClientPrincipal(createLocalDevelopmentPrincipal()));
        }
        return;
      }

      const res = await fetch("/.auth/me");
      const data = await res.json();

      if (!isCancelled) {
        setUser(normalizeClientPrincipal(data.clientPrincipal));
      }
    }

    getUser();

    return () => {
      isCancelled = true;
    };
  }, []);

  function signIn() {
    window.location.href = "/.auth/login/aad";
  }

  function signOut() {
    window.location.href = "/.auth/logout";
  }

  return { user, signIn, signOut };
}
