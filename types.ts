import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export interface User {
  id: string;
  email: string;
  name: string;
  avatar: string;
  role: 'USER' | 'ADMIN';
}

export interface AnalysisResult {
  action: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;
  entry: string;
  sl: string;
  tp1: string;
  tp2: string;
  technical_analysis: string;
  sentiment_analysis: string;
  confidence_reason: string;
  pair: string;
  assetType: 'forex' | 'crypto';
}

export interface Analysis {
  id: string;
  userId: string;
  ocrText: string;
  result: AnalysisResult;
  confidence: number;
  feedback: 'PROFIT' | 'LOSS' | null;
  pair: string;
  assetType: string;
  createdAt: string;
}
