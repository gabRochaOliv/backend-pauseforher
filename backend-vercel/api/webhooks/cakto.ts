import { VercelRequest, VercelResponse } from '@vercel/node';
import { supabase } from '../../lib/supabase.js';

/**
 * Webhook Handler para Cakto
 * 
 * Este endpoint processa notificações de pagamento da Cakto e gerencia o acesso Premium
 * usando um modelo baseado em data de expiração (premium_until).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const { secret, event } = req.body;
        const { data } = req.body || {};
        
        // 1. Normalização e Validação Inicial
        const email = data?.customer?.email?.trim().toLowerCase();
        console.log(`[CAKTO] Webhook recebido: ${event} - Email: ${email}`);

        const CAKTO_SECRET = process.env.CAKTO_WEBHOOK_SECRET;
        if (!CAKTO_SECRET || secret !== CAKTO_SECRET) {
            console.error('[CAKTO] Falha na autenticação: Secret inválido.');
            return res.status(401).json({ error: 'Unauthorized' });
        }

        if (!email) {
            console.error('[CAKTO] Payload sem e-mail do cliente.');
            return res.status(400).json({ error: 'Missing customer email' });
        }

        const status = data?.status;
        const subscriptionStatus = data?.subscription?.status;
        const caktoSubscriptionId = data?.subscription?.id || data?.id || 'unknown';
        const productName = data?.product?.name || data?.offer?.title || 'Plano Desconhecido';
        const offerId = data?.offer?.id || 'unknown';

        // 2. Localizar ou Criar a usuária (auth.users)
        let userId: string | null = null;
        let page = 1;
        let hasMore = true;

        console.log(`[CAKTO] Buscando usuária no Supabase Auth: ${email}`);

        while (hasMore) {
            const { data: usersData, error: usersError } = await supabase.auth.admin.listUsers({ 
                page: page, 
                perPage: 1000 
            });

            if (usersError) {
                console.error('[CAKTO] Erro ao listar usuárias:', usersError);
                return res.status(500).json({ error: 'Failed to access Auth Users' });
            }

            const foundUser = usersData?.users?.find(u => u.email?.toLowerCase() === email);
            if (foundUser) {
                userId = foundUser.id;
                console.log(`[CAKTO] Usuária encontrada: ${email} (ID: ${userId})`);
                break;
            }

            if (!usersData?.users || usersData.users.length < 1000) {
                hasMore = false;
            } else {
                page++;
            }
        }

        // Se não encontrar, cria a usuária automaticamente
        if (!userId) {
            console.log(`[CAKTO] Usuária NÃO encontrada. Criando nova conta para: ${email}`);
            const { data: newUser, error: createError } = await supabase.auth.admin.createUser({
                email: email,
                email_confirm: true,
                user_metadata: { created_by: 'cakto_webhook', automated: true }
            });

            if (createError) {
                console.error('[CAKTO] Erro ao criar usuária:', createError.message);
                if (createError.message.includes('already exists')) {
                    // Caso de corrida: tenta buscar novamente via query de tabela ou simplifica com erro 500
                    return res.status(500).json({ error: 'User already exists conflict' });
                }
                return res.status(500).json({ error: 'Failed to create user' });
            }

            if (newUser?.user) {
                userId = newUser.user.id;
                console.log(`[CAKTO] Usuária criada com sucesso: ${email} (ID: ${userId})`);
            }
        }

        if (!userId) {
            console.error(`[CAKTO] Falha crítica: userId nulo para ${email}`);
            return res.status(500).json({ error: 'User identification failed' });
        }

        console.log(`[CAKTO] Prosseguindo com atualização de acesso para: ${userId}`);

        // 3. Definir regras de duração do plano
        const premiumEvents = ['subscription_renewed', 'purchase_approved', 'order_paid'];
        const removalEvents = ['subscription_canceled', 'subscription_expired', 'charge_refunded', 'refund', 'chargeback'];

        if (premiumEvents.includes(event) && (status === 'paid' || subscriptionStatus === 'active')) {
            
            // Identificar duração baseada no nome do produto/oferta ou ID
            let daysToAdd = 30; // Default mensal
            let planType = 'monthly';

            const nameLower = productName.toLowerCase();
            if (nameLower.includes('anual') || nameLower.includes('yearly') || nameLower.includes('ano') || offerId === 'wmgqcek') {
                daysToAdd = 365;
                planType = 'yearly';
            } else if (nameLower.includes('semanal') || nameLower.includes('weekly') || offerId === '3atgd8g_838082') {
                daysToAdd = 7;
                planType = 'weekly';
            } else {
                // assume mensal por padrão (ex: 3466ktv)
                daysToAdd = 30;
                planType = 'monthly';
            }

            console.log(`[CAKTO] Identificado plano: ${planType} (+${daysToAdd} dias) para o produto: ${productName}`);

            // 4. Buscar profile atual para calculo aditivo
            const { data: profile, error: fetchError } = await supabase
                .from('profiles')
                .select('premium_until')
                .eq('user_id', userId)
                .maybeSingle();

            if (fetchError) {
                console.error('[CAKTO] Erro ao buscar profile:', fetchError);
            }

            let baseDate = new Date();
            if (profile?.premium_until) {
                const currentPremiumUntil = new Date(profile.premium_until);
                if (currentPremiumUntil > baseDate) {
                    baseDate = currentPremiumUntil;
                    console.log(`[CAKTO] Renovação antecipada. Somando à data existente: ${profile.premium_until}`);
                }
            }

            const newPremiumUntil = new Date(baseDate.getTime() + daysToAdd * 24 * 60 * 60 * 1000);

            // 5. Atualizar ou Criar Profile (Upsert)
            const updatePayload = {
                user_id: userId,
                // Removido email do payload do profiles caso a coluna não exista. 
                // Se a coluna existir, o upsert funcionará. Se não, melhor omitir ou garantir.
                premium_until: newPremiumUntil.toISOString(),
                plan_type: planType,
                subscription_status: 'active',
                billing_provider: 'cakto',
                updated_at: new Date().toISOString()
            };

            const { error: profileError } = await supabase
                .from('profiles')
                .upsert(updatePayload, { onConflict: 'user_id' });

            if (profileError) {
                console.error('[CAKTO] Erro ao atualizar profile:', profileError);
                return res.status(500).json({ error: 'Database update failed' });
            }

            console.log(`[CAKTO] Sucesso: premium_until atualizado para ${newPremiumUntil.toISOString()}`);

            // 6. Registrar histórico em subscriptions
            const { error: subError } = await supabase.from('subscriptions').upsert({
                user_id: userId,
                status: 'active',
                provider: 'cakto',
                external_subscription_id: caktoSubscriptionId,
                updated_at: new Date().toISOString()
            }, { onConflict: 'user_id,provider' });

            if (subError) {
                console.error('[CAKTO] Erro ao gravar histórico de assinatura:', subError);
            }

            // 7. Gerar Magic Link para acesso imediato
            let accessLink = null;
            try {
                // Rota raiz do app para redirecionamento, removendo barras extras
                const baseUrl = (process.env.APP_URL || 'https://pause-for-her.vercel.app').replace(/\/$/, '');
                
                const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
                    type: 'magiclink',
                    email: email,
                    options: { redirectTo: baseUrl }
                });

                if (linkError) {
                    console.error('[CAKTO] Erro ao gerar Magic Link:', linkError.message);
                } else if (linkData?.properties?.action_link) {
                    accessLink = linkData.properties.action_link;
                    console.log(`[CAKTO] Magic Link gerado: ${accessLink}`);
                }
            } catch (linkCatch) {
                console.error('[CAKTO] Erro inesperado ao gerar link:', linkCatch);
            }

            // 8. Notificar n8n (para envio de e-mail com o link real)
            const n8nWebhookUrl = process.env.N8N_WEBHOOK_URL;
            if (n8nWebhookUrl && accessLink) {
                try {
                    console.log(`[CAKTO] Notificando n8n: ${n8nWebhookUrl}`);
                    
                    // Dispara a chamada sem travar a resposta principal (opcional: usar await para garantir log de erro)
                    const n8nResponse = await fetch(n8nWebhookUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            email: email,
                            access_link: accessLink,
                            plan_type: planType,
                            premium_until: newPremiumUntil.toISOString(),
                            event: event,
                            product_name: productName
                        })
                    });

                    if (!n8nResponse.ok) {
                        console.error(`[CAKTO] Falha na resposta do n8n: ${n8nResponse.status}`);
                    } else {
                        console.log('[CAKTO] n8n notificado com sucesso.');
                    }
                } catch (n8nError) {
                    // Erro no n8n não deve falhar o webhook da Cakto
                    console.error('[CAKTO] Erro ao chamar webhook n8n:', n8nError);
                }
            } else {
                console.log('[CAKTO] Notificação n8n ignorada: URL ou Link ausente.');
            }

            return res.status(200).json({ 
                success: true, 
                premium_until: newPremiumUntil.toISOString(),
                access_link: accessLink 
            });

        } else if (removalEvents.includes(event)) {
            // Caso de cancelamento/estorno
            console.log(`[CAKTO] Processando remoção de acesso para evento: ${event}`);
            
            await supabase.from('profiles').update({
                subscription_status: 'canceled',
                // Não removemos o premium_until para que a usuária aproveite o tempo restante
                updated_at: new Date().toISOString()
            }).eq('user_id', userId);

            await supabase.from('subscriptions').update({
                status: 'canceled',
                updated_at: new Date().toISOString()
            }).eq('user_id', userId).eq('provider', 'cakto');

            return res.status(200).json({ success: true, message: 'Access status updated to canceled' });
        }

        console.log(`[CAKTO] Evento não alterou plano: ${event}`);
        return res.status(200).json({ received: true, ignored: true });

    } catch (err: unknown) {
        console.error('[CAKTO] Erro fatal no processamento:', err);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
}
