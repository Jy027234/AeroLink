// AeroLink Push Notification Client
// Handles Service Worker registration, Push subscription, and notification permission

const SW_PATH = '/sw.js';

export interface PushSubscriptionData {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

/**
 * Check if Push API is supported in this browser
 */
export function isPushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window;
}

/**
 * Register the Service Worker
 */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) {
    console.warn('Service Worker not supported');
    return null;
  }
  try {
    const registration = await navigator.serviceWorker.register(SW_PATH);
    return registration;
  } catch (error) {
    console.error('Service Worker registration failed:', error);
    return null;
  }
}

/**
 * Get the current Service Worker registration
 */
export async function getServiceWorkerRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  return navigator.serviceWorker.getRegistration(SW_PATH);
}

/**
 * Request notification permission from the user
 */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!('Notification' in window)) {
    throw new Error('Notifications not supported');
  }
  if (Notification.permission === 'granted') {
    return 'granted';
  }
  if (Notification.permission === 'denied') {
    throw new Error('Notification permission denied');
  }
  return Notification.requestPermission();
}

/**
 * Subscribe to Push notifications using the VAPID public key
 */
export async function subscribeToPush(vapidPublicKey: string): Promise<PushSubscriptionData | null> {
  const registration = await getServiceWorkerRegistration();
  if (!registration) {
    throw new Error('Service Worker not registered');
  }

  const permission = await requestNotificationPermission();
  if (permission !== 'granted') {
    throw new Error('Notification permission not granted');
  }

  const existingSubscription = await registration.pushManager.getSubscription();
  if (existingSubscription) {
    return convertSubscription(existingSubscription);
  }

  const applicationServerKey = urlBase64ToUint8Array(vapidPublicKey);
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey,
  });

  return convertSubscription(subscription);
}

/**
 * Unsubscribe from Push notifications
 */
export async function unsubscribeFromPush(): Promise<boolean> {
  const registration = await getServiceWorkerRegistration();
  if (!registration) return false;

  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return true;

  const result = await subscription.unsubscribe();
  return result;
}

/**
 * Check if the user is currently subscribed to Push
 */
export async function isPushSubscribed(): Promise<boolean> {
  const registration = await getServiceWorkerRegistration();
  if (!registration) return false;
  const subscription = await registration.pushManager.getSubscription();
  return subscription !== null;
}

/**
 * Convert PushSubscription to serializable data
 */
function convertSubscription(subscription: PushSubscription): PushSubscriptionData {
  return {
    endpoint: subscription.endpoint,
    keys: {
      p256dh: arrayBufferToBase64(subscription.getKey('p256dh')!),
      auth: arrayBufferToBase64(subscription.getKey('auth')!),
    },
  };
}

/**
 * Convert URL-safe Base64 to Uint8Array (for VAPID key)
 */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

/**
 * Convert ArrayBuffer to Base64 string
 */
function arrayBufferToBase64(buffer: ArrayBuffer | null): string {
  if (!buffer) return '';
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}
