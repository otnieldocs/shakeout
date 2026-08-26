import type { ShakeoutConfig } from './src/targets/types.js';

/**
 * Copy to `shakeout.config.ts` and edit. The copy is gitignored — it names your
 * environments, and in most setups that is not something to publish.
 */
const config: ShakeoutConfig = {
  defaultTarget: 'staging',
  reportingDir: './reporting',
  vaultDir: './.vault',

  targets: [
    {
      name: 'staging',
      baseUrl: 'https://staging.example.com',

      /*
       * Deny-by-default. Navigation to anything not listed here is ABORTED.
       * Include every origin a flow legitimately lands on — your app, your
       * identity provider, any hosted checkout or OAuth consent screen.
       *
       * Subresources (analytics beacons, fonts, CDN assets) are NOT blocked by
       * this list; only top-level navigations are.
       */
      allowedOrigins: [
        'https://staging.example.com',
        'https://your-tenant.auth0.com',
        'https://sandbox.midtrans.com',
        'https://sandbox-buy.paddle.com',
        'https://www.tiktok.com',
      ],

      /* Recorded in every report, so a result is traceable to what it ran against. */
      integrations: {
        midtrans: 'sandbox',
        paddle: 'sandbox',
        tiktok: 'sandbox',
        youtube: 'test-channel-UCxxxx',
        ga4: 'G-STAGING000',
      },
    },

    /*
     * A production target needs BOTH `production: true` here AND
     * SHAKEOUT_ALLOW_PRODUCTION=yes in the environment. Two locks, because
     * Shakeout writes real data and runs real teardowns.
     */
    // {
    //   name: 'production',
    //   baseUrl: 'https://app.example.com',
    //   allowedOrigins: ['https://app.example.com'],
    //   production: true,
    // },
  ],
};

export default config;
