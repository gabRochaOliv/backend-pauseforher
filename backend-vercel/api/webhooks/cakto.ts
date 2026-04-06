import { VercelRequest, VercelResponse } from '@vercel/node';
import { supabase } from '../../lib/supabase.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const secret = req.body?.secret;
        const event = req.body?.event;
        const status = req.body?.data?.status;
        const subscriptionStatus = req.body?.data?.subscription?.status;
        const email = req.body?.data?.customer?.email;

        // 1. Validação estrita do Secret
        const CAKTO_SECRET = process.env.CAKTO_WEBHOOK_SECRET;
        
        if (!CAKTO_SECRET) {
            console.error('[CAKTO] Erro Crítico: CAKTO_WEBHOOK_SECRET não está configurado.');
            return res.status(500).json({ error: 'Internal Server Error' });
        }

        if (secret !== CAKTO_SECRET) {
            console.error('[CAKTO] Secret inválido fornecido.');
            return res.status(401).json({ error: 'Unauthorized' });
        }

        // 2. Identificação do Usuário
        if (!email) {
            console.error('[CAKTO] Nenhum e-mail encontrado no payload do webhook.');
            return res.status(400).json({ error: 'Missing customer email' });
        }

        console.log(`[CAKTO] Recebido evento: ${event} para o email: ${email}`);

        let newPlan = '';

        // 3. Regras de atualização de Plano mais robustas
        const premiumEvents = ['subscription_renewed', 'purchase_approved', 'order_paid'];
        const removalEvents = [
            'subscription_canceled', 
            'subscription_expired', 
            'charge_refunded', 
            'refund', 
            'chargeback'
        ];

        if (
            premiumEvents.includes(event) && 
            (status === 'paid' || subscriptionStatus === 'active')
        ) {
            newPlan = 'premium';
        } else if (removalEvents.includes(event)) {
            newPlan = 'free';
        } else {
            console.log(`[CAKTO] Evento não altera o plano (${event}). Retornando sucesso sem alterações.`);
            return res.status(200).json({ received: true, ignored: true });
        }

        // 4. Atualizar banco de dados Supabase e verificar resultado
        const { data, error } = await supabase
            .from('profiles')
            .update({ plan: newPlan })
            .eq('email', email)
            .select('id');

        if (error) {
            console.error(`[CAKTO] Erro ao atualizar o Supabase para plan=${newPlan}:`, error);
            return res.status(500).json({ error: 'Database update failed' });
        }

        if (!data || data.length === 0) {
            console.error(`[CAKTO] Nenhum perfil encontrado para o e-mail: ${email}. Status não alterado.`);
            return res.status(404).json({ error: 'User profile not found' });
        }

        console.log(`[CAKTO] Plano de ${email} (ID: ${data[0].id}) atualizado para '${newPlan}' com sucesso!`);
        
        // 5. Retorno Rápido HTTP 200
        return res.status(200).json({ received: true, success: true });

    } catch (err: unknown) {
        console.error('[CAKTO] Erro interno:', err);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
}
