import { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    console.log('[WEBHOOK CAKTO BE ISOLADO] Evento recebido no placeholder principal.');
    
    return res.status(200).json({ received: true, status: 'placeholder' });
}
