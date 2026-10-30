/**
 * Color themes for `clerum__generate_dashboard`. Each theme has a light and a
 * dark set; the page switches between them with the color scheme and prints in
 * the light one.
 */

export type ThemeName = 'default' | 'corporate' | 'warm' | 'alert'

export interface DashboardThemeColors {
  bg: string
  surface: string
  surfaceMuted: string
  text: string
  textMuted: string
  textSoft: string
  border: string
  primary: string
  primaryHover: string
  accent: string
  success: string
  warning: string
  danger: string
  successBg: string
  warningBg: string
  dangerBg: string
  neutralBg: string
  /** Series colors, each at least 3:1 against `surface` (WCAG 1.4.11). */
  chart: string[]
}

export interface DashboardTheme {
  name: ThemeName
  light: DashboardThemeColors
  dark: DashboardThemeColors
  fontFamily: string
}

export const DASHBOARD_THEMES: Record<ThemeName, DashboardTheme> = {
  default: {
    name: 'default',
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
    light: {
      bg: '#f8fafc',
      surface: '#ffffff',
      surfaceMuted: '#f1f5f9',
      text: '#0f172a',
      textMuted: '#475569',
      textSoft: '#94a3b8',
      border: '#e2e8f0',
      primary: '#0f172a',
      primaryHover: '#1e293b',
      accent: '#3b82f6',
      success: '#16a34a',
      warning: '#ca8a04',
      danger: '#dc2626',
      successBg: '#dcfce7',
      warningBg: '#fef9c3',
      dangerBg: '#fee2e2',
      neutralBg: '#f1f5f9',
      chart: ['#0f172a', '#16a34a', '#d97706', '#dc2626', '#2563eb', '#9333ea', '#0891b2'],
    },
    dark: {
      bg: '#0f172a',
      surface: '#1e293b',
      surfaceMuted: '#334155',
      text: '#f1f5f9',
      textMuted: '#cbd5e1',
      textSoft: '#94a3b8',
      border: '#334155',
      primary: '#3b82f6',
      primaryHover: '#60a5fa',
      accent: '#3b82f6',
      success: '#22c55e',
      warning: '#facc15',
      danger: '#f87171',
      successBg: '#14532d',
      warningBg: '#713f12',
      dangerBg: '#7f1d1d',
      neutralBg: '#334155',
      chart: ['#e2e8f0', '#4ade80', '#fbbf24', '#f87171', '#60a5fa', '#c084fc', '#22d3ee'],
    },
  },
  corporate: {
    name: 'corporate',
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
    light: {
      bg: '#f1f5f9',
      surface: '#ffffff',
      surfaceMuted: '#e0f2fe',
      text: '#1e293b',
      textMuted: '#475569',
      textSoft: '#94a3b8',
      border: '#cbd5e1',
      primary: '#1e3a8a',
      primaryHover: '#1e40af',
      accent: '#0891b2',
      success: '#059669',
      warning: '#ca8a04',
      danger: '#b91c1c',
      successBg: '#dcfce7',
      warningBg: '#fef9c3',
      dangerBg: '#fee2e2',
      neutralBg: '#e0f2fe',
      chart: ['#1e40af', '#0e7490', '#0f766e', '#047857', '#4d7c0f', '#a16207', '#dc2626'],
    },
    dark: {
      bg: '#0f172a',
      surface: '#1e293b',
      surfaceMuted: '#1e3a5f',
      text: '#e0f2fe',
      textMuted: '#bae6fd',
      textSoft: '#7dd3fc',
      border: '#1e3a5f',
      primary: '#3b82f6',
      primaryHover: '#60a5fa',
      accent: '#0ea5e9',
      success: '#34d399',
      warning: '#facc15',
      danger: '#f87171',
      successBg: '#14532d',
      warningBg: '#713f12',
      dangerBg: '#7f1d1d',
      neutralBg: '#1e3a5f',
      chart: ['#60a5fa', '#22d3ee', '#2dd4bf', '#34d399', '#a3e635', '#facc15', '#f87171'],
    },
  },
  warm: {
    name: 'warm',
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
    light: {
      bg: '#f7f7f5',
      surface: '#fffdfa',
      surfaceMuted: '#f1ede6',
      text: '#2f2823',
      textMuted: '#66584c',
      textSoft: '#857568',
      border: '#d6d2cc',
      primary: '#b45309',
      primaryHover: '#ca6e1e',
      accent: '#b45309',
      success: '#15803d',
      warning: '#b45309',
      danger: '#9f1239',
      successBg: '#dcfce7',
      warningBg: '#fef3c7',
      dangerBg: '#fee2e2',
      neutralBg: '#f1ede6',
      chart: ['#b45309', '#2f2823', '#0f766e', '#1e40af', '#9f1239', '#4d7c0f', '#7c3aed'],
    },
    dark: {
      bg: '#0e0f10',
      surface: '#141517',
      surfaceMuted: '#1f2123',
      text: '#f2f2ef',
      textMuted: '#c6c8cc',
      textSoft: '#92969e',
      border: '#2a2c2f',
      primary: '#ca6e1e',
      primaryHover: '#e0833a',
      accent: '#ca6e1e',
      success: '#34d399',
      warning: '#fbbf24',
      danger: '#fb7185',
      successBg: '#14532d',
      warningBg: '#78350f',
      dangerBg: '#7f1d1d',
      neutralBg: '#1f2123',
      chart: ['#f59e0b', '#e7e5e4', '#2dd4bf', '#60a5fa', '#fb7185', '#a3e635', '#a78bfa'],
    },
  },
  alert: {
    name: 'alert',
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
    light: {
      bg: '#fef2f2',
      surface: '#ffffff',
      surfaceMuted: '#fee2e2',
      text: '#1f2937',
      textMuted: '#4b5563',
      textSoft: '#9ca3af',
      border: '#fecaca',
      primary: '#9f1239',
      primaryHover: '#be123c',
      accent: '#dc2626',
      success: '#15803d',
      warning: '#ca8a04',
      danger: '#9f1239',
      successBg: '#dcfce7',
      warningBg: '#fef9c3',
      dangerBg: '#fecaca',
      neutralBg: '#fee2e2',
      chart: ['#9f1239', '#dc2626', '#c2410c', '#a16207', '#4d7c0f', '#0e7490', '#1e40af'],
    },
    dark: {
      bg: '#1f0a0a',
      surface: '#2c0f0f',
      surfaceMuted: '#3d1414',
      text: '#fee2e2',
      textMuted: '#fca5a5',
      textSoft: '#f87171',
      border: '#3d1414',
      primary: '#fb7185',
      primaryHover: '#fda4af',
      accent: '#f87171',
      success: '#34d399',
      warning: '#facc15',
      danger: '#fb7185',
      successBg: '#14532d',
      warningBg: '#713f12',
      dangerBg: '#7f1d1d',
      neutralBg: '#3d1414',
      chart: ['#fb7185', '#fca5a5', '#fb923c', '#facc15', '#a3e635', '#22d3ee', '#93c5fd'],
    },
  },
}
