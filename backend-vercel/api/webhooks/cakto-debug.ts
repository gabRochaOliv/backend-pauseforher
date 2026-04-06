import { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        console.log('--- [WEBHOOK DEBUG: CAKTO BE ISOLADO] ---');
        console.log('[HEADERS]:', JSON.stringify(req.headers, null, 2));
        console.log('[BODY]:', JSON.stringify(req.body, null, 2));
        console.log('------------------------------------------');

        return res.status(200).json({ received: true, debug: 'acknowledged' });
    } catch (err: unknown) {
        console.error('Error Debug Endpoint:', err);
        return res.status(500).json({ error: 'Internal Error' });
    }
}
