# SofIA — CloudSix

**Secretária virtual e gestão local: WhatsApp-First, Web-Extended.**

> **Estado atual:** agente por áudio na sua própria conta do WhatsApp, com Baileys e IA exclusivamente pela Groq, integrado a um dashboard React/Vite. Clientes, serviços, visitas, orçamentos com PDF, catálogo de materiais, movimentações de estoque e caixa são registros reais no SQLite local. Ações de gestão por voz exigem confirmação em um novo áudio; o painel consulta e salva os mesmos dados. Não há dados de demonstração pré-carregados.

## Referências e cobertura

- **Fonte oficial de escopo:** [Descrição do Agente CloudSix — aba SofIA](https://docs.google.com/document/d/1bdl3aO33JhW88fJatrre9h1xCd7R32TM6FBTO6l92k0/edit?tab=t.jo3qj0l5spdi).
- **Implementação, limites e avaliação dos 12 links:** [ARQUITETURA.md](ARQUITETURA.md).
- As sete funcionalidades oficiais permanecem descritas na seção 5, distinguindo a parte entregue do que ainda é evolução de produto.

A instalação atual é **local, para uma conta e um espaço de trabalho por `DATABASE_PATH`**. Next.js, Auth0, PostgreSQL e storage S3 não são usados nem pré-requisitos do painel. Não há serviço Cloud API da Meta no caminho implementado.

## Usar agora

### Requisitos e instalação

- **Node.js 24 ou superior** e npm. O backend TypeScript roda com remoção nativa de tipos do Node e usa seu SQLite nativo; não precisa de compilação do backend. O frontend React é compilado pelo Vite antes de servir o painel.
- Para o **painel isolado**, não é necessário pareamento, chave Groq nem conexão com o WhatsApp. Após instalar as dependências, a gestão funciona localmente.
- Para o **bot**, sua conta do WhatsApp no celular, acesso a **Dispositivos conectados**, internet e chave Groq com acesso/cota para os modelos configurados. Obtenha a chave no [console Groq](https://console.groq.com/keys); cotas gratuitas, limites e preços dependem da conta/modelo, sem promessa de uso gratuito ilimitado.

```sh
npm ci
```

Use o `package-lock.json` para reproduzir as versões. Baileys está fixado em **`7.0.0-rc14`**, uma release candidate, não uma garantia de estabilidade. Não troque por `latest` sem revisar as mudanças. O hook `postinstall` reaplica com `patch-package` as correções em `patches/`, incluindo ajustes de tipos e remoção de dados criptográficos dos logs das dependências; preserve esse hook.

**Somente se `.env` ainda não existir**, copie `.env.example` para `.env` e edite-o localmente. Em uma instalação existente, **preserve o `.env`, o caminho do banco e a sessão vinculada**. A ampliação das tabelas é aditiva no mesmo SQLite: não apague dados nem faça novo pareamento para obter o dashboard. As antigas variáveis `OPENAI_*` não são usadas.

| Variável | Valor / uso |
| --- | --- |
| `GROQ_KEY` | Chave local, obrigatória em `npm start`, dispensada em `npm run dashboard` e `npm run pair`. O nome é exatamente `GROQ_KEY`, não `GROQ_API_KEY`. |
| `GROQ_MODEL` | `qwen/qwen3.6-27b`, texto/visão em preview, em modo não pensante (`reasoning_effort=none`). |
| `GROQ_TRANSCRIPTION_MODEL` | `whisper-large-v3-turbo`; a transcrição usa português (`language=pt`), fixo no conector. |
| `WHATSAPP_ALLOWED_JIDS` | Vazio: somente a conversa consigo mesmo. JIDs privados adicionais habilitam conversa, **não acesso aos dados de gestão**. |
| `DATABASE_PATH` | `./data/sofia.sqlite`; sessão/chaves, inbox/contexto, dados de negócio e operações de confirmação duráveis. Um espaço de trabalho por arquivo. |
| `TIME_ZONE` | `America/Sao_Paulo`; fuso IANA usado pela agenda, datas locais e contexto de gestão. |
| `DASHBOARD_PORT` | `3000`; painel vinculado somente a `127.0.0.1`. |

### Modos de execução

| Comando | O que inicia | Chave Groq / WhatsApp |
| --- | --- | --- |
| `npm run dashboard` | Compila o frontend e inicia **somente o servidor web local**. Abra **http://127.0.0.1:3000** (ou a porta configurada). | Não precisa de chave, não conecta ao WhatsApp e não apresenta QR. |
| `npm run pair` | Pareia pelo QR do terminal, salva a sessão e termina. **Não inicia o painel.** | Não precisa de chave e não chama IA. |
| `npm start` | Compila o frontend e inicia **bot + servidor web**, usando a mesma base. | Exige `GROQ_KEY`; reutiliza a sessão WhatsApp existente. |

`npm run build` executa `vite build` e gera os arquivos estáticos em `web/dist/`; os hooks `prestart` e `predashboard` já executam essa etapa. O servidor Node serve os arquivos junto à API de gestão. Não é preciso manter um servidor de desenvolvimento Vite separado, e o backend continua executando os arquivos TypeScript nativamente no Node 24.

Para usar o WhatsApp:

1. Se ainda não houver sessão, execute `npm run pair`. No celular, abra **WhatsApp → Dispositivos conectados → Conectar dispositivo** e leia o QR. O QR é uma credencial temporária; não o compartilhe.
2. Aguarde o pareamento terminar. Com `GROQ_KEY` no `.env`, execute `npm start` e mantenha o processo ativo.
3. Abra o painel no endereço local indicado pelo terminal e envie seus pedidos por voz na conversa consigo mesmo.
4. Use `Ctrl+C` para parar. Isso não apaga a base nem desvincula a conta. Para revogar o vínculo, remova o dispositivo pelo WhatsApp no celular.

Use **um único processo por conta/banco**: não execute `pair`, `dashboard` e `start` simultaneamente sobre a mesma base. Para trocar de painel isolado para bot + painel, pare um modo antes de iniciar o outro. A sessão e os registros permanecem no arquivo configurado.

### Dashboard: os mesmos registros do bot

O painel começa vazio em uma base nova; cadastros e indicadores surgem dos seus registros, não de exemplos fictícios. **Salvar no formulário é a confirmação explícita da alteração**: não exige um segundo áudio. Falha de validação ou conflito não significa gravação concluída.

| Área | Operação atual |
| --- | --- |
| Visão geral | Indicadores de visitas, propostas, serviços, estoque e caixa derivados do banco. |
| Clientes e serviços | Cadastro de contatos e dados do cliente; serviços vinculados ao cliente e organizados nas cinco etapas oficiais do Kanban. |
| Agenda | Visitas com início/fim, local, notas, status e vínculos ao cliente/serviço. Fuso declarado e validação de conflitos entre visitas agendadas. |
| Orçamentos | Propostas com itens, unidades, quantidades, preços, desconto, validade e status; total calculado e PDF para download. |
| Materiais e estoque | Catálogo com unidade/custo/estoque mínimo e livro de entradas, consumos/saídas e ajustes, com vínculo opcional ao serviço. |
| Caixa | Receitas e despesas, categoria, data, cliente/serviço, valores realizados e pendentes; visão por período. |

O mês selecionado delimita visitas, movimentações e lançamentos de caixa. Cadastros, serviços, propostas e saldo atual de estoque são gerais. No caixa, o saldo inicial considera os realizados anteriores ao mês e a série mostra os realizados do período; contas pendentes a receber/pagar mostram as pendências em aberto, não dinheiro já realizado.

A agenda é **interna à SofIA**. Não sincroniza com Google Calendar ou Microsoft e não envia lembretes/follow-ups automáticos pelo WhatsApp. O painel **não mostra o histórico completo de conversas, credenciais, chaves Signal, QR ou telefone da conta vinculada**. Contatos cadastrados como dados de negócio são distintos da identidade técnica do dispositivo.

O servidor aceita acesso em **loopback `127.0.0.1`**, e gravações exigem a mesma origem do painel. **Não há login público nem suporte a hospedagem pública/multiusuário.** Não exponha a porta por túnel, proxy público ou redirecionamento de rede; a máquina e o perfil local do navegador fazem parte da fronteira de confiança. A API entrega dados de negócio, não tabelas de sessão, inbox ou segredos.

### Gestão por voz: propor, revisar, confirmar

No WhatsApp, abra a conversa **com você mesmo** e envie um áudio normalmente; não há prefixo ou palavra-chave para fazer um pedido. Por exemplo:

> “Cadastre a cliente Ana com o telefone e o endereço que vou informar.”
>
> “Agende uma visita à Ana amanhã das 9h às 10h no endereço cadastrado.”
>
> “Prepare um orçamento para a Ana com os itens, quantidades e preços que vou ditar.”
>
> “Registre uma entrada de 20 metros do fio cadastrado para o serviço da Ana.”
>
> “Registre como realizado o recebimento de dois mil reais da Ana pelo serviço.”

O agente consulta os registros autorizados, pede informações faltantes e **propõe** uma ação estruturada. Um pedido não é uma gravação: confira no resumo o cliente/serviço, a data e o fuso, a unidade, as quantidades, os valores e o status antes de confirmar.

1. A proposta fica pendente por **15 minutos**, vinculada à sua identidade, conversa e aos **parâmetros exatos** da operação. Há **uma operação pendente por vez**, não um lote oculto de alterações.
2. Para efetivar, envie **um novo áudio dizendo apenas “confirmar”**. Para desistir, envie **um novo áudio dizendo apenas “cancelar”**. Texto digitado, uma confirmação citada em anexo, “sim” ou pedir e confirmar no mesmo áudio não substituem essa etapa.
3. A decisão de confirmar/cancelar é **determinística após a transcrição**, fora da escolha do modelo. O agente não dispõe de ferramenta para confirmar sozinho uma operação.
4. A confirmação revalida os dados no momento da transação: versão desatualizada, estoque insuficiente ou sobreposição de visitas podem impedir a gravação. Um conflito não atualiza silenciosamente a proposta: cancele-a e faça um novo pedido com os dados corretos. Propostas expiradas também precisam ser refeitas e revisadas; uma confirmação antiga não autoriza parâmetros novos.
5. O sucesso só é informado **após o commit no SQLite**. Ao confirmar um orçamento, o PDF dos dados salvos é anexado à resposta **na conversa consigo mesmo**; não é enviado automaticamente ao cliente.

As consultas não alteram dados. Uma gravação confirmada por voz aparece no dashboard, e uma edição no painel deve ser considerada nas próximas operações por voz. O contexto do modelo não é a fonte da verdade do negócio.

### Valores, estoque e documentos

- **Dinheiro:** centavos inteiros. Quantidades usam unidade explícita e milésimos inteiros (`quantityMilli`); por exemplo, 1,250 metro corresponde a 1.250 milésimos de metro. Totais de itens usam arredondamento determinístico de meio para cima, sem aritmética financeira em ponto flutuante.
- **Estoque:** o saldo resulta do livro de movimentações; uma saída não pode deixá-lo negativo. Entrada e saída têm quantidades positivas; **ajuste informa o saldo físico final desejado**, e o sistema registra a diferença no livro. Catálogo, entrada e consumo são registros distintos.
- **Caixa:** `paid` (realizado), `pending` (pendente) e `void` (anulado) são estados diferentes. Pendências não entram como dinheiro já realizado; lançamentos anulados não representam receita/despesa efetiva.
- **Sem lançamentos implícitos:** uma compra/entrada de estoque não vira despesa paga, e criar/aprovar um orçamento não vira receita ou recebimento. Registre o evento financeiro correspondente explicitamente para evitar dupla contagem.
- **Orçamento/PDF:** vem da proposta salva, com fotografia dos dados do cliente e dos itens daquele orçamento, número e totais calculados. Não é um rascunho textual do modelo nem uma consulta aos preços atuais do catálogo a cada download. Alterar o cliente/material não reescreve o documento salvo; editar explicitamente o orçamento atualiza sua fotografia do cliente.
- **Agenda:** horários locais são interpretados em `TIME_ZONE`; visitas têm início/fim e status agendada, realizada ou cancelada. Datas/horários locais inválidos, inexistentes ou ambíguos no fuso são recusados. Visitas agendadas não podem se sobrepor; uma pode começar exatamente quando a anterior termina. Visita salva não é alarme ou mensagem agendada.

### Referências por imagem/PDF e outras conversas

- **Só voz:** o áudio novo autorizado é transcrito e recebe resposta em texto. Continue com outro áudio; pode usar **Responder** no texto do bot, com o contexto textual recente da conversa.
- **Foto:** envie a imagem, use **Responder** nela e grave “Extraia os itens e valores deste recibo”. A voz é a instrução e a foto é referência. Extrair dados não altera estoque/caixa antes de proposta e confirmação no chat consigo mesmo.
- **PDF de entrada:** envie o arquivo, responda a ele com voz e peça uma análise. Esse caminho de leitura é distinto da geração de um orçamento PDF salvo.
- **Texto, foto, PDF ou legenda sem áudio:** não iniciam o agente. Texto citado por voz não vira anexo; citar outro áudio/vídeo é uma referência não suportada. Visualização única não é aberta; vídeos e diário multimodal não estão implementados.

**Todo áudio novo elegível no chat autorizado é um pedido**, enquanto o bot estiver ativo. Não envie ali voz que não queira compartilhar com a Groq. Transcrição, referência citada e contexto relevante seguem ao provedor; no chat consigo mesmo, dados de gestão consultados para atender ao pedido também podem compor esse contexto. O código-fonte e as credenciais da sessão não são enviados à IA.

Para habilitar **outras conversas privadas**, use identificadores exatos, por exemplo:

```dotenv
WHATSAPP_ALLOWED_JIDS=5511999999999@s.whatsapp.net,123456789@lid
```

Esses valores são exemplos, não contatos configurados. JID de telefone (`@s.whatsapp.net`) e LID (`@lid`) são domínios diferentes; números iguais não os tornam equivalentes. Nesses chats, somente áudios **recebidos da outra pessoa** são processados, e a resposta volta à mesma conversa. Mensagens que você envia para outros contatos são ignoradas.

**A allowlist habilita apenas conversa e análise de referências, sem consulta ou escrita ERP/CRM.** Acesso por voz aos clientes, serviços, agenda, propostas, estoque e caixa fica restrito ao chat consigo mesmo. Avise qualquer terceiro antes de habilitá-lo sobre o envio dos áudios/referências à Groq. Grupos, status, newsletters, chats não autorizados e eventos de histórico (`append`) são ignorados; não há importação indiscriminada de conversas.

### Provedor e limites de mídia

O **OpenAI Agents SDK** e o pacote npm `openai` são bibliotecas open source de orquestração/cliente, configuradas exclusivamente para **https://api.groq.com/openai/v1**. A conversa usa **Chat Completions**, não Responses, e o tracing está desativado. Não há chamadas, traces, consumo de créditos ou fallback para a API OpenAI; cabeçalhos herdados de configuração OpenAI não são encaminhados.

- **Anexos:** até **20 MiB** e **60 segundos de download** por arquivo. Imagens JPEG/PNG/WebP; PDFs; áudios OGG/Opus, MP3, MP4/M4A, WAV, WebM e FLAC. AAC/AMR não são convertidos automaticamente; não há FFmpeg no fluxo.
- **PDF de entrada:** `pdfjs-dist` e `@napi-rs/canvas` rasterizam **todas as páginas localmente**. As imagens seguem à visão Groq em lotes de até **3 páginas**, com síntese para documentos maiores. Não há upload do PDF bruto nem corte silencioso das páginas finais. A análise não garante transcrição integral ou leitura perfeita.
- **Groq:** transcrição em português (`language=pt`), até **800 tokens de saída por chamada** de geração, **60 segundos por requisição** e **retries=0**. O timeout é por chamada, não um prazo total para um PDF multipágina; mais páginas e chamadas de ferramentas podem consumir mais cota/tempo.

O limite conservador de 3 imagens segue o [cartão do modelo Qwen3.6-27B](https://console.groq.com/docs/model/qwen/qwen3.6-27b), apesar de o [guia de visão](https://console.groq.com/docs/vision) mencionar 5. Consulte também [transcrição](https://console.groq.com/docs/speech-to-text) e [limites de taxa](https://console.groq.com/docs/rate-limits).

### Persistência, falhas e privacidade

O SQLite preserva credenciais do dispositivo, chaves Signal, inbox/deduplicação e contexto textual do conector, junto às **novas tabelas de negócio, propostas de ação e resultados idempotentes**. A migração é aditiva no mesmo arquivo, após a validação da autenticação existente. Não exige reinstalar a conta, resetar a sessão ou copiar dados para um novo banco.

A memória conversacional recupera as **10 últimas rodadas textuais concluídas**, até 20 itens de pedido/resposta; isso não importa todo o WhatsApp nem apaga automaticamente registros antigos. O dashboard lê **somente dados de negócio**, não essa memória nem os segredos da conta. Anexos analisados não formam uma biblioteca permanente de fotos/vídeos.

Operações pendentes e seus resultados sobrevivem ao reinício; uma mesma operação não deve gerar uma segunda gravação por reentrega. **Isso não garante entrega de mensagem/PDF exatamente uma vez no WhatsApp.** Se o commit ocorreu mas o envio falhou ou ficou incerto, **confira o registro no painel antes de repetir qualquer pedido**. Não há reenvio cego nem repetição automática de chamadas à IA; conexão restaurada não significa resultado entregue. Uma pendência não confirmada não é um registro salvo.

- `.env`, `data/` e `web/dist/` ficam fora do Git. Mantenha qualquer `DATABASE_PATH` alternativo privado e fora do versionamento.
- Diretório e banco têm permissões privadas; isso **não é criptografia em repouso**. Proteja máquina, navegador, chave Groq e backups, incluindo auxiliares SQLite. Não compartilhe a base como diagnóstico: ela contém a sessão da conta e dados de clientes.
- Chaves, QR, credenciais e corpos de mensagens não devem aparecer em logs ou relatórios. Desativar tracing não elimina o tratamento pela Groq dos dados autorizados enviados à API.
- Baileys é open source (MIT), mas **não é oficial nem afiliado ao WhatsApp/Meta**. Há risco de restrição/banimento, desconexões e quebras de protocolo. Não há envio em massa, evasão, promessa contra detecção nem homologação empresarial.

### Ajuda e verificações locais

```sh
npm start -- --help
npm run typecheck
npm test
```

A ajuda pode ser consultada sem chave nem pareamento; pelo npm, o hook de build do frontend ainda é executado antes dela. A existência desses comandos não afirma que foram executados na sua máquina nem homologa o WhatsApp real. Verificações locais não devem exigir chamadas pagas ou mensagens reais. O fluxo real de pareamento, voz, confirmação e entrega precisa ser distinguido de uma chamada isolada à Groq e do funcionamento local do painel.

---

## Produto — escopo oficial e cobertura atual

As seções seguintes preservam a visão do documento oficial. **Gestão local e dashboard estão implementados; nem toda automação da visão de produto está pronta.** O estado de cada funcionalidade aparece na seção 5.

## 1. Descrição do projeto

A SofIA transforma informações produzidas durante o trabalho — áudios, mensagens de texto, fotos, documentos e imagens — em registros organizados e ações de gestão para prestadores de serviços, profissionais autônomos e pequenos negócios. Na implementação atual, **o áudio é a entrada obrigatória do agente** e imagem/PDF podem ser referências citadas; texto solto não o ativa.

O **WhatsApp é a interface operacional por voz**; o **Web Dashboard local** complementa a operação com visão e edição de clientes, serviços, materiais, estoque, orçamentos, visitas e fluxo financeiro. A proposta é levar recursos de ERP/CRM à rotina do profissional, reduzindo a barreira de adoção sem confundir interpretação do modelo com transação confirmada.

## 2. Público-alvo

### Público primário

Profissionais autônomos, MEIs, microempreendedores e pequenos empreiteiros de serviços manuais, manutenção e pequenas obras: pedreiros, pintores, carpinteiros, eletricistas, encanadores, gesseiros, mecânicos e técnicos de manutenção.

### Público secundário

Pequenas equipes familiares, mestres de obras, supervisores de serviços, auxiliares administrativos e responsáveis por orçamentos e organização financeira. O escopo de público não significa que esta instalação local tenha contas de múltiplos operadores.

### Perfil de uso

Rotina operacional e de campo, pouco tempo administrativo e uso frequente do WhatsApp com clientes e fornecedores. Voz e imagem reduzem a digitação; o painel permite revisar os registros de forma explícita.

## 3. Problemas que a solução busca resolver

| Problema | Resposta proposta |
| --- | --- |
| Falta de controle de materiais e estoque | Estruturar entradas, compras, comprovantes e consumo por serviço, distinguindo-os de pagamentos. |
| Perda de informações no WhatsApp | Organizar dados por cliente/trabalho; diário multimodal e histórico completo de comunicação permanecem futuros. |
| Sobrecarga administrativa | Converter pedidos por voz em propostas verificáveis, confirmadas antes da gravação. |
| Orçamentos pouco profissionais | Gerar PDFs dos registros reais; follow-ups automáticos ainda não existem. |
| Dificuldade de adoção de ERP/CRM | Usar linguagem natural no WhatsApp e revisão visual no painel, sem exigir infraestrutura empresarial externa. |

## 4. Arquitetura e meio de atuação

| Camada | Implementação atual |
| --- | --- |
| WhatsApp | Conta própria vinculada via Baileys; novos áudios autorizados e imagem/PDF citados. Gestão apenas no chat consigo mesmo. |
| Agente e domínio | Groq transcreve/interpreta; ferramentas consultam/proponem ações. Código determinístico valida e confirma no SQLite. |
| Web Dashboard | React/Vite, API Node local e os mesmos serviços de domínio; formulário salvo é confirmação explícita. |

O painel não substitui a conversa, e nenhum dos dois usa a memória do modelo como banco de dados. A separação e a fronteira local estão detalhadas em [ARQUITETURA.md](ARQUITETURA.md).

## 5. Funcionalidades principais — implementado e restante

### 5.1. Gerador inteligente de orçamentos por voz

**Visão oficial:** interpretar serviço, materiais, quantidades, valores, prazo, condições de pagamento e cliente para produzir um orçamento profissional em PDF, pronto para envio.

**Implementado:** proposta estruturada por voz com confirmação, edição no painel, itens com unidade/quantidade/preço, desconto, validade, notas e status; cliente/serviço vinculados; número, totais e fotografia dos dados persistidos. PDF disponível para download e anexado ao confirmar o orçamento por voz no chat consigo mesmo. Dados faltantes devem ser perguntados, não inventados.

**Limite:** encaminhar ao cliente é uma decisão manual do profissional; não há envio automático a terceiros, follow-up ou assinatura eletrônica. Condições complementares podem ser registradas nas notas, sem uma automação contratual separada.

### 5.2. Controle inteligente de estoque por voz ou imagem

**Visão oficial:** interpretar notas/cupons/recibos para identificar materiais, quantidades, valores, compra e fornecedor; atualizar estoque e vincular à obra. Exemplo: “Comprei 20 metros de fio de 2,5 mm para a obra da Ana.”

**Implementado:** catálogo, unidades, mínimos, entradas, consumos/saídas e ajustes em livro persistente, vínculo ao serviço, saldo não negativo e operações por voz com confirmação ou pelo painel. Foto/PDF citado por um áudio pode servir de referência para propor a movimentação.

**Restante:** cadastro estruturado de fornecedores/compras e acervo permanente de comprovantes; leitura multimodal não é conciliação fiscal automática. Uma nota recebida sozinha não altera dados e uma entrada não lança despesa automaticamente.

### 5.3. Gestão inteligente de clientes

**Visão oficial:** centralizar contatos, endereços, serviços, propostas, datas, materiais, valores, status, comunicação e registros da execução, com lembretes de visitas, retornos, pagamentos e propostas.

**Implementado:** cadastro de clientes e vínculos a serviços, visitas, orçamentos e caixa; agenda interna com fuso e verificação de sobreposição. As informações podem ser consultadas e alteradas pelo painel e por voz autorizada/confirmada.

**Restante:** histórico completo de comunicação por cliente, fotos/diário, lembretes automáticos pelo WhatsApp e sincronização Google/Microsoft. Salvar uma visita não agenda uma mensagem.

### 5.4. Alertas inteligentes de materiais e desperdício

**Visão oficial:** identificar falta de materiais, consumo acima da estimativa, divergências de compra/uso, reposição e indícios de desperdício; aprender com serviços anteriores.

**Implementado:** estoque mínimo configurável e indicação de materiais com saldo baixo, calculada sobre movimentações reais.

**Restante:** previsão de consumo/desperdício, comparação com estimativas, aprendizado histórico e notificações proativas. Histórico insuficiente não deve produzir uma previsão inventada.

### 5.5. Kanban inteligente de obras e serviços

**Visão oficial e fluxo implementado:** **Aguardando visita → Orçamento → Aguardando aprovação → Em execução → Concluído**.

**Implementado:** serviços ligados ao cliente com descrição/endereço e etapa editável no painel ou proposta por voz, mediante confirmação. “Comecei hoje a reforma da cozinha da Ana” precisa identificar o serviço correto antes da alteração; nomes ambíguos não autorizam escolher outro trabalho.

**Limite:** não há mudança automática por uma conversa de terceiro nem encadeamento implícito entre aprovação do orçamento, estoque e recebimento.

### 5.6. Diário de bordo multimodal

**Visão oficial:** organizar **fotos, vídeos, áudios e mensagens** cronologicamente por cliente, obra e data para acompanhar progresso, alterações, comprovação, prestação de contas e relatórios.

**Ainda não implementado:** análise pontual de imagem/PDF e contexto textual do bot não constituem diário, biblioteca de anexos ou relatórios de execução. Vídeos não são aceitos no conector atual.

### 5.7. Controle financeiro simplificado

**Visão oficial:** receitas, despesas, materiais, recebimentos, pendências, margem estimada, fluxo de caixa e custos por obra. Exemplo: “O cliente me pagou R$ 2.000 hoje.”

**Implementado:** lançamentos explícitos de receita/despesa em centavos, categoria/data, vínculos ao cliente/serviço e estados realizado, pendente e anulado; saldos e fluxo por período no painel. O áudio propõe o lançamento e um novo áudio o confirma sem duplicar a mesma operação.

**Restante:** conciliação bancária, margem estimada consolidada por serviço e automações de cobrança. Compra, orçamento, despesa e pagamento continuam eventos distintos; proposta aprovada não é dinheiro recebido.

## 6. Diferencial da solução

A SofIA se adapta à rotina de campo sem retirar do profissional o controle das alterações: **comunicação natural + IA multimodal + registros verificáveis + gestão local**. O WhatsApp reduz a digitação; o dashboard e a confirmação explícita tornam os dados e os efeitos da operação visíveis.
