// Test helper: renders UI inside the app's providers with a memory router.
import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router';
import { Providers } from '../Providers';

export function testQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
}

let lastLocation = '';
function LocationSpy() {
  const loc = useLocation();
  lastLocation = `${loc.pathname}${loc.search}`;
  return null;
}

export const currentLocation = () => lastLocation;

export function renderWithApp(ui: ReactElement, { route = '/', client = testQueryClient() } = {}) {
  const result = render(
    <QueryClientProvider client={client}>
      <Providers>
        <MemoryRouter initialEntries={[route]}>
          {ui}
          <LocationSpy />
        </MemoryRouter>
      </Providers>
    </QueryClientProvider>,
  );
  return { ...result, client };
}
