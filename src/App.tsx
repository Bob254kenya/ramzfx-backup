// src/App.tsx - Complete with OAuth callback route

import { motion } from "framer-motion";
import { Activity } from "lucide-react";
import bgHero from '@/assets/bg-hero.jpeg';
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import LoginPage from "@/components/LoginPage";
import AppLayout from "@/components/layout/AppLayout";
import Dashboard from "@/pages/Dashboard";
import Markets from "@/pages/Markets";
import Analyzer from "@/pages/Analyzer";
import AutoTrade from "@/pages/AutoTrade";
import BotsPage from "@/pages/BotsPage";
import SmartBotPage from "@/pages/SmartBotPage";
import AdvancedRamzBot from "@/pages/AdvancedRamzBot";
import ProScannerBot from "@/pages/ProScannerBot";
import TradingChart from "@/pages/TradingChart";
import TradeHistory from "@/pages/TradeHistory";
import SettingsPage from "@/pages/SettingsPage";
import CopyTradingManager from "@/pages/CopyTradingManager";
import FreeBots from "@/pages/FreeBots";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

// OAuth Callback Handler Component
function OAuthCallbackHandler() {
  const { isLoading, isAuthorized } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    // AuthProvider handles the token parsing
    // Once authorized, redirect to home
    if (!isLoading && isAuthorized) {
      navigate('/', { replace: true });
    }
  }, [isLoading, isAuthorized, navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center">
        <div className="w-12 h-12 border-4 border-primary/30 border-t-primary rounded-full animate-spin mx-auto mb-4" />
        <p className="text-muted-foreground">Completing login...</p>
      </div>
    </div>
  );
}

function AppRoutes() {
  const { isAuthorized, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen relative flex items-center justify-center overflow-hidden">
        <div className="absolute inset-0 z-0">
          <img src={bgHero} alt="" className="w-full h-full object-cover" />
          <div className="absolute inset-0 bg-background/80 backdrop-blur-sm" />
        </div>
        <motion.div
          className="text-center flex flex-col items-center gap-6 relative z-10"
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.5 }}
        >
          <div className="relative w-24 h-24">
            <motion.div
              className="absolute inset-0 rounded-full border-2 border-primary/20"
              animate={{ scale: [1, 1.3, 1], opacity: [0.3, 0, 0.3] }}
              transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
            />
            <motion.div
              className="absolute inset-2 rounded-full border-2 border-primary/30"
              animate={{ scale: [1, 1.2, 1], opacity: [0.5, 0.1, 0.5] }}
              transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut', delay: 0.3 }}
            />
            <motion.div
              className="absolute inset-0 rounded-full border-[3px] border-transparent border-t-primary border-r-primary/50"
              animate={{ rotate: 360 }}
              transition={{ duration: 1.2, repeat: Infinity, ease: 'linear' }}
            />
            <div className="absolute inset-0 flex items-center justify-center">
              <motion.div animate={{ scale: [1, 1.1, 1] }} transition={{ duration: 1.5, repeat: Infinity }}>
                <Activity className="w-8 h-8 text-primary" />
              </motion.div>
            </div>
          </div>
          <div className="space-y-2">
            <motion.h1
              className="text-2xl font-bold text-foreground tracking-tight"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3, duration: 0.5 }}
            >
              WELCOME TO{' '}
              <span className="text-primary">RAMZFX.SITE</span>
            </motion.h1>
          </div>
          <motion.div
            className="w-48 h-1 rounded-full bg-border overflow-hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.8 }}
          >
            <motion.div
              className="h-full rounded-full bg-primary"
              initial={{ width: '0%' }}
              animate={{ width: '100%' }}
              transition={{ duration: 3, ease: 'easeInOut', repeat: Infinity }}
            />
          </motion.div>
        </motion.div>
      </div>
    );
  }

  if (!isAuthorized) {
    return <LoginPage />;
  }

  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/" element={<ProScannerBot />} />
        <Route path="/pro-bot" element={<ProScannerBot />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/markets" element={<Markets />} />
        <Route path="/analyzer" element={<Analyzer />} />
        <Route path="/auto-trade" element={<AutoTrade />} />
        <Route path="/bots" element={<BotsPage />} />
        <Route path="/smart-bot" element={<SmartBotPage />} />
        <Route path="/ramz-bot" element={<AdvancedRamzBot />} />
        <Route path="/chart" element={<TradingChart />} />
        <Route path="/history" element={<TradeHistory />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/copy-trading" element={<CopyTradingManager />} />
        <Route path="/free-bots" element={<FreeBots />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            {/* OAuth callback route - MUST be outside AppRoutes */}
            <Route path="/oauth/callback" element={<OAuthCallbackHandler />} />
            <Route path="/*" element={<AppRoutes />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
