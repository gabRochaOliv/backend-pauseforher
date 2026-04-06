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
        const caktoSubscriptionId = req.body?.data?.subscription?.id || req.body?.data?.id || 'unknown';

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

        // 2. Identificação base
        if (!email) {
            console.error('[CAKTO] Nenhum e-mail encontrado no payload do webhook.');
            return res.status(400).json({ error: 'Missing customer email' });
        }

        console.log(`[CAKTO] Processando evento: ${event} para o email: ${email}`);

        // 3. Localizar o user_id da usuária em auth.users
        let userId: string | null = null;
        let page = 1;
        let hasMore = true;

        while (hasMore) {
            const { data: usersData, error: usersError } = await supabase.auth.admin.listUsers({ 
                page: page, 
                perPage: 1000 
            });

            if (usersError) {
                console.error('[CAKTO] Erro ao listar usuárias no Supabase Auth:', usersError);
                return res.status(500).json({ error: 'Failed to access Auth Users' });
            }

            const foundUser = usersData?.users?.find(u => u.email === email);
            if (foundUser) {
                userId = foundUser.id;
                break;
            }

            if (!usersData?.users || usersData.users.length < 1000) {
                hasMore = false;
            } else {
                page++;
            }
        }

        if (!userId) {
            console.error(`[CAKTO] Nenhuma usuária encontrada em auth.users com o e-mail: ${email}`);
            return res.status(404).json({ error: 'User not found in Auth system' });
        }

        console.log(`[CAKTO] Usuária '${email}' localizada local: (ID: ${userId})`);

        // 4. Regras de atualização de Plano e Subscription Status
        let newPlan = '';
        let subStatus = '';

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
            subStatus = 'active';
        } else if (removalEvents.includes(event)) {
            newPlan = 'free';
            subStatus = 'canceled';
        } else {
            console.log(`[CAKTO] Evento não altera o plano (${event}). Retornando sucesso sem alterações.`);
            return res.status(200).json({ received: true, ignored: true });
        }

        // 5. Atualizar na tabela `profiles` via user_id
        const { data: updatedProfiles, error: profileError } = await supabase
            .from('profiles')
            .update({ plan: newPlan })
            .eq('user_id', userId)
            .select('id, user_id');

        if (profileError) {
            console.error(`[CAKTO] Erro ao atualizar o Supabase para profiles.plan=${newPlan}:`, profileError);
            return res.status(500).json({ error: 'Database profiles update failed' });
        }

        if (!updatedProfiles || updatedProfiles.length === 0) {
            console.error(`[CAKTO] Nenhuma linha atualizada na tabela profiles para o user_id: ${userId}`);
            return res.status(404).json({ error: 'Profile not found to update' });
        }

        // 6. Cuidar do registro na tabela 'subscriptions' de forma segura
        const { data: existingSub, error: readSubError } = await supabase
            .from('subscriptions')
            .select('id')
            .eq('user_id', userId)
            .eq('provider', 'cakto')
            .maybeSingle();

        if (readSubError) {
             console.error('[CAKTO] Erro silencioso ao consultar tabela subscriptions:', readSubError);
        }

        let subUpdateError;

        if (existingSub) {
            // Atualizar existente
            const updateReq = await supabase
                .from('subscriptions')
                .update({
                    status: subStatus,
                    external_subscription_id: caktoSubscriptionId,
                    updated_at: new Date().toISOString()
                })
                .eq('id', existingSub.id);
            subUpdateError = updateReq.error;
        } else {
            // Inserir novo
            const insertReq = await supabase
                .from('subscriptions')
                .insert({
                    user_id: userId,
                    status: subStatus,
                    provider: 'cakto',
                    external_subscription_id: caktoSubscriptionId,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                });
            subUpdateError = insertReq.error;
        }

        if (subUpdateError) {
            console.error('[CAKTO] Erro ao gravar na tabela subscriptions:', subUpdateError);
            // Continua retornando 200 porque perfil pelo menos foi atualizado
        }

        console.log(`[CAKTO] Sucesso finalizado! profile_id: ${userId} -> profiles.plan: '${newPlan}' | subscriptions.status: '${subStatus}'`);
        
        // 7. Retorno Rápido HTTP 200
        return res.status(200).json({ received: true, success: true });

    } catch (err: unknown) {
        console.error('[CAKTO] Erro interno fatal:', err);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
}
