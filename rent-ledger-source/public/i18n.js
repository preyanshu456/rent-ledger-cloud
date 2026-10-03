// English / हिन्दी. The screens are written in English; when Hindi is chosen,
// interface text (headings, labels, buttons, statuses) is swapped for its
// Hindi equivalent as it appears. Names, addresses, amounts and anything
// typed by people are never changed. Messages from the server stay in the
// language they were written in (reminder templates have their own Hindi
// versions).
(() => {
  const HI = {
    // navigation & shell
    'Dashboard': 'डैशबोर्ड', 'Finance': 'वित्त', 'Ledger': 'खाता बही', 'Reconciliation': 'बैंक मिलान', 'Reports': 'रिपोर्ट',
    'Leases': 'लीज़', 'Reminders': 'रिमाइंडर', 'Maintenance': 'मरम्मत', 'Expenses': 'खर्च', 'Assistant': 'सहायक', 'Insights': 'विश्लेषण',
    'Settings & team': 'सेटिंग्स और टीम', 'Notifications': 'सूचनाएँ', 'Overview': 'सारांश', 'Money': 'पैसा', 'Tenancy': 'किरायेदारी', 'Admin': 'प्रशासन',
    '+ Add building': '+ इमारत जोड़ें', '◉ View your profile': '◉ अपनी प्रोफ़ाइल देखें', '↪ Sign out': '↪ साइन आउट', 'Sign out': 'साइन आउट',
    'Theme': 'थीम', 'Language': 'भाषा', 'My profile': 'मेरी प्रोफ़ाइल', '← My home': '← मेरा घर', 'My home': 'मेरा घर', 'Home': 'होम',
    'Messages': 'संदेश', 'Documents': 'दस्तावेज़', 'Your profile': 'आपकी प्रोफ़ाइल',
    // auth
    'Owner': 'मालिक', 'Tenant': 'किरायेदार', 'Manager': 'मैनेजर', 'WELCOME BACK': 'फिर से स्वागत है', 'Sign in as owner': 'मालिक के रूप में साइन इन करें',
    'Sign in as tenant': 'किरायेदार के रूप में साइन इन करें', 'Mobile number or email': 'मोबाइल नंबर या ईमेल', 'Password': 'पासवर्ड', 'Sign in': 'साइन इन करें',
    'Forgot password?': 'पासवर्ड भूल गए?', 'Create an account': 'खाता बनाएँ', 'New here?': 'नए हैं?', 'Create account': 'खाता बनाएँ', 'Full name': 'पूरा नाम',
    'Invite code': 'आमंत्रण कोड', 'Create password': 'पासवर्ड बनाएँ', 'Already have access?': 'पहले से खाता है?', 'Back to sign in': 'साइन इन पर वापस जाएँ',
    'Send code': 'कोड भेजें', 'Verification code': 'सत्यापन कोड', 'New password': 'नया पासवर्ड', 'Reset password': 'पासवर्ड रीसेट करें', 'Install app': 'ऐप इंस्टॉल करें',
    'Registered mobile number': 'पंजीकृत मोबाइल नंबर',
    // common words
    'Save': 'सहेजें', 'Cancel': 'रद्द करें', 'Confirm': 'पुष्टि करें', 'Delete': 'हटाएँ', 'Edit': 'बदलें', 'Close': 'बंद करें', 'Back': 'वापस', 'Add': 'जोड़ें',
    'Search': 'खोजें', 'Filter': 'फ़िल्टर', 'Apply': 'लागू करें', 'Download CSV': 'CSV डाउनलोड करें', 'Print / PDF': 'प्रिंट / PDF', 'View': 'देखें', 'Open': 'खोलें',
    'Approve': 'स्वीकृत करें', 'Reject': 'अस्वीकार करें', 'Send': 'भेजें', 'Upload': 'अपलोड करें', 'Refresh': 'रीफ़्रेश करें', 'Details': 'विवरण', 'Actions': 'कार्य',
    'Status': 'स्थिति', 'Amount': 'राशि', 'Date': 'तारीख़', 'Due date': 'देय तिथि', 'Notes': 'टिप्पणी', 'Reason': 'कारण', 'Reference': 'संदर्भ', 'Method': 'तरीका',
    'Property': 'संपत्ति', 'Room': 'कमरा', 'Month': 'महीना', 'Year': 'साल', 'From': 'से', 'To': 'तक', 'Total': 'कुल', 'All': 'सभी', 'None': 'कोई नहीं',
    'Description': 'विवरण', 'Category': 'श्रेणी', 'Priority': 'प्राथमिकता', 'Title': 'शीर्षक', 'Vendor': 'विक्रेता', 'Type': 'प्रकार', 'Channel': 'माध्यम',
    'Message': 'संदेश', 'Subject': 'विषय', 'Rent': 'किराया', 'Deposit': 'जमा राशि', 'Electricity': 'बिजली', 'Gas': 'गैस', 'Balance': 'बकाया शेष',
    'Outstanding': 'बकाया', 'Overdue': 'देरी से बकाया', 'Credit': 'अग्रिम जमा', 'Paid': 'भुगतान किया', 'Received': 'प्राप्त', 'Billed': 'बिल किया गया',
    'Collected': 'वसूला गया', 'Net': 'शुद्ध', 'Statement': 'स्टेटमेंट', 'Receipt': 'रसीद', 'Receipts': 'रसीदें', 'Yes': 'हाँ', 'No': 'नहीं',
    // statuses
    'paid': 'भुगतान हुआ', 'due': 'देय', 'overdue': 'देरी', 'partial': 'आंशिक', 'waived': 'माफ़', 'void': 'रद्द', 'occupied': 'भरा हुआ', 'vacant': 'खाली',
    'draft': 'मसौदा', 'active': 'सक्रिय', 'ended': 'समाप्त', 'terminated': 'समाप्त किया गया', 'proposed': 'प्रस्तावित', 'executed': 'पूरा हुआ', 'rejected': 'अस्वीकृत',
    'failed': 'विफल', 'queued': 'कतार में', 'sending': 'भेजा जा रहा है', 'sent': 'भेजा गया', 'simulated': 'पूर्वावलोकन (नहीं भेजा)', 'cancelled': 'रद्द किया गया',
    'unmatched': 'मिलान बाकी', 'matched': 'मिलान हुआ', 'ignored': 'अनदेखा', 'verified': 'सत्यापित', 'recorded': 'दर्ज', 'agreed': 'सहमत', 'refunded': 'लौटाया गया',
    'Submitted': 'जमा किया गया', 'Under review': 'समीक्षा में', 'Approved': 'स्वीकृत', 'Assigned': 'सौंपा गया', 'In progress': 'काम जारी', 'Waiting for you': 'आपके जवाब का इंतज़ार',
    'Resolved': 'हल हुआ', 'Closed': 'बंद', 'low': 'कम', 'normal': 'सामान्य', 'high': 'ज़्यादा', 'urgent': 'तुरंत',
    // dashboard & legacy owner screens
    'Buildings': 'इमारतें', 'Occupied rooms': 'भरे हुए कमरे', 'Rent collected (this mo.)': 'वसूला किराया (इस महीने)', 'Rent pending (this mo.)': 'बाकी किराया (इस महीने)',
    'Electricity collected': 'वसूली गई बिजली', 'Electricity pending': 'बाकी बिजली', 'Gas collected': 'वसूली गई गैस', 'Gas pending': 'बाकी गैस',
    'Open rent entries': 'खुली किराया प्रविष्टियाँ', 'Open electricity entries': 'खुली बिजली प्रविष्टियाँ', 'Open gas entries': 'खुली गैस प्रविष्टियाँ',
    'Add a building': 'इमारत जोड़ें', 'Save building': 'इमारत सहेजें', 'Mark moved out': 'मकान छोड़ा दर्ज करें', 'Tenant login': 'किरायेदार लॉगिन',
    'Previous tenants': 'पिछले किरायेदार', 'Add tenant': 'किरायेदार जोड़ें', '+ Add tenant': '+ किरायेदार जोड़ें', 'Save tenant': 'किरायेदार सहेजें',
    'Mobile number *': 'मोबाइल नंबर *', 'Full name *': 'पूरा नाम *', 'Move-in date': 'आने की तारीख़', 'Moved in': 'आए', 'Moved out': 'गए',
    'Password & security': 'पासवर्ड और सुरक्षा', 'Change password': 'पासवर्ड बदलें', 'Data backup': 'डेटा बैकअप', 'Download backup': 'बैकअप डाउनलोड करें',
    'Appearance': 'रूप', 'Account information': 'खाते की जानकारी', 'Your tenancy': 'आपकी किरायेदारी', 'Contact & identity': 'संपर्क और पहचान',
    // tenant portal
    'YOUR HOME': 'आपका घर', 'Monthly rent': 'मासिक किराया', 'Rent outstanding': 'बकाया किराया', 'Electricity outstanding': 'बकाया बिजली', 'Gas outstanding': 'बकाया गैस',
    'Payment pending': 'भुगतान बाकी', 'All caught up': 'सब चुकता', 'Rent history': 'किराया इतिहास', 'Electricity bills': 'बिजली के बिल', 'Gas bills': 'गैस के बिल',
    'Period': 'अवधि', 'Payment': 'भुगतान', 'Add proof': 'प्रमाण जोड़ें', 'View proof': 'प्रमाण देखें', 'TOTAL PENDING': 'कुल बाकी', 'Last 6 entries': 'पिछली 6 प्रविष्टियाँ',
    'Upcoming dues': 'आने वाले भुगतान', 'Your lease': 'आपकी लीज़', 'Other charges': 'अन्य शुल्क', 'Download statement': 'स्टेटमेंट डाउनलोड करें', 'Payments & receipts': 'भुगतान और रसीदें',
    'New request': 'नया अनुरोध', 'Submit request': 'अनुरोध भेजें', 'Your requests': 'आपके अनुरोध', 'It’s fixed': 'ठीक हो गया', 'Not fixed yet': 'अभी ठीक नहीं हुआ',
    'Add a comment': 'टिप्पणी जोड़ें', 'Mark all read': 'सब पढ़ा हुआ करें', 'No notifications yet.': 'अभी कोई सूचना नहीं।', 'Write to your owner': 'मालिक को लिखें',
    'Reminders by email, SMS or WhatsApp': 'ईमेल, SMS या WhatsApp से रिमाइंडर', 'Email reminders': 'ईमेल रिमाइंडर', 'SMS reminders': 'SMS रिमाइंडर', 'WhatsApp reminders': 'WhatsApp रिमाइंडर',
    'Save preferences': 'पसंद सहेजें', 'Language & reminders': 'भाषा और रिमाइंडर',
    // modules
    'Record payment': 'भुगतान दर्ज करें', 'Add charge': 'शुल्क जोड़ें', 'Bills': 'बिल', 'Payments': 'भुगतान', 'Adjust': 'समायोजन', 'Reverse': 'वापस करें',
    'Apply credit': 'अग्रिम जमा लगाएँ', 'Proofs to review': 'जाँचने के लिए प्रमाण', 'Accept': 'स्वीकार करें', 'Import statement': 'स्टेटमेंट आयात करें',
    'Find match': 'मिलान खोजें', 'Ignore': 'अनदेखा करें', 'Reopen': 'फिर खोलें', 'Suggested matches': 'सुझाए गए मिलान', 'New lease': 'नई लीज़', 'Activate': 'सक्रिय करें',
    'Renew': 'नवीनीकरण', 'End lease': 'लीज़ समाप्त करें', 'Read from agreement': 'एग्रीमेंट से पढ़ें', 'Outbox': 'आउटबॉक्स', 'Templates': 'संदेश प्रारूप',
    'Preview & draft': 'पूर्वावलोकन और मसौदा', 'Create drafts': 'मसौदे बनाएँ', 'Approve & send selected': 'चुने हुए स्वीकृत करके भेजें', 'Retry': 'फिर कोशिश करें',
    'New maintenance request': 'नया मरम्मत अनुरोध', 'Timeline': 'समयरेखा', 'Change status': 'स्थिति बदलें', 'Add expense': 'खर्च जोड़ें', 'Void': 'रद्द करें',
    'Cash flow': 'नकदी प्रवाह', 'Review alerts': 'जाँच अलर्ट', 'Forecast (estimate)': 'अनुमान', 'Assumptions': 'मान्यताएँ', 'Organisation': 'संगठन', 'Team': 'टीम',
    'Audit log': 'ऑडिट लॉग', 'Backups': 'बैकअप', 'Invite manager': 'मैनेजर को आमंत्रित करें', 'Tenancy, deposit & move-out': 'किरायेदारी, जमा राशि और मकान छोड़ना',
    'Move-in record': 'आने का रिकॉर्ड', 'Move-out record': 'जाने का रिकॉर्ड', 'Security deposit': 'सिक्योरिटी डिपॉज़िट', 'Deposit settlement': 'जमा राशि का निपटान',
    'Agree settlement': 'निपटान पर सहमति', 'Record refund': 'वापसी दर्ज करें', 'Ask': 'पूछें', 'Clear chat': 'चैट साफ़ करें', 'Proposals waiting for approval': 'स्वीकृति के इंतज़ार में प्रस्ताव',
    'Basic mode': 'साधारण मोड', 'AI mode': 'AI मोड', 'Collection rate': 'वसूली दर', 'Expected rent': 'अपेक्षित किराया', 'Net cash flow': 'शुद्ध नकदी प्रवाह',
    'Due this month': 'इस महीने देय', 'Tenant balances': 'किरायेदारों का बकाया', 'By property': 'संपत्ति अनुसार', 'Leases ending soon': 'जल्द ख़त्म होने वाली लीज़',

    // more form labels
    'Move-out date': 'जाने की तारीख़', 'Keys': 'चाबियाँ', 'Electricity meter reading': 'बिजली मीटर रीडिंग', 'Gas meter reading': 'गैस मीटर रीडिंग',
    'Water meter reading': 'पानी मीटर रीडिंग', 'Condition notes': 'हालत पर टिप्पणी', 'Checklist': 'जाँच सूची', 'Proposed / notice date': 'प्रस्तावित / नोटिस तिथि',
    'Deposit held': 'जमा राशि (रखी हुई)', 'Dues today (net of credit)': 'आज का बकाया (अग्रिम घटाकर)', 'Deductions (damage, cleaning, etc.)': 'कटौतियाँ (नुकसान, सफ़ाई आदि)',
    '+ Add deduction': '+ कटौती जोड़ें', 'Remove': 'हटाएँ', 'Update draft': 'मसौदा अपडेट करें', 'Prepare settlement': 'निपटान तैयार करें', 'Preview statement': 'स्टेटमेंट देखें',
    'Add photo': 'फ़ोटो जोड़ें', 'Tenant can see': 'किरायेदार देख सकता है', 'Record': 'दर्ज करें', 'Received on': 'प्राप्ति तिथि', 'Paid by *': 'भुगतान का तरीका *',
    'Tenant *': 'किरायेदार *', 'Amount (₹) *': 'राशि (₹) *', 'Save payment': 'भुगतान सहेजें', 'Record a payment': 'भुगतान दर्ज करें', 'Add a charge': 'शुल्क जोड़ें',
    'For month': 'किस महीने का', 'Bill': 'बिल', 'Due': 'देय', 'Check': 'जाँच', 'Reversed': 'वापस किया गया', 'Unpaid (open)': 'बाकी (खुले)', 'Partly paid': 'आंशिक भुगतान',
    'Voided': 'रद्द किए गए', 'Waived': 'माफ़ किए गए', 'All tenants': 'सभी किरायेदार', 'All properties': 'सभी संपत्तियाँ', 'All types': 'सभी प्रकार', 'Choose tenant': 'किरायेदार चुनें',
    'Start date *': 'शुरू होने की तिथि *', 'End date': 'समाप्ति तिथि', 'Rent (₹) *': 'किराया (₹) *', 'Security deposit (₹)': 'सिक्योरिटी डिपॉज़िट (₹)', 'Rent frequency': 'किराया अवधि',
    'Save as draft': 'मसौदे के रूप में सहेजें', 'Term': 'अवधि', 'Request': 'अनुरोध', 'Where': 'कहाँ', 'Cost': 'लागत', 'Updated': 'अपडेट', 'Create request': 'अनुरोध बनाएँ',
    'Property *': 'संपत्ति *', 'Title *': 'शीर्षक *', 'Category *': 'श्रेणी *', 'Save expense': 'खर्च सहेजें', 'From month': 'शुरुआती महीना', 'To month': 'आख़िरी महीना',
    'Month by month': 'महीने-दर-महीने', 'Money received': 'प्राप्त राशि', 'Outstanding today': 'आज का बकाया', 'Overdue today': 'आज तक देरी से बकाया',
    'Collected on these bills': 'इन बिलों पर वसूली', 'Facts (today)': 'तथ्य (आज)', 'Likely collection': 'संभावित वसूली',
    'Who would be reminded': 'किसे याद दिलाया जाएगा', 'Reminder type': 'रिमाइंडर का प्रकार', 'Show': 'दिखाएँ', 'Drafts': 'मसौदे', 'Reminder settings': 'रिमाइंडर सेटिंग्स',
    'Save settings': 'सेटिंग्स सहेजें', 'Channels': 'माध्यम', 'Your language': 'आपकी भाषा', 'Pending invites': 'लंबित आमंत्रण', 'Create invite': 'आमंत्रण बनाएँ',
    'Back up now': 'अभी बैकअप लें', 'What needs fixing? *': 'क्या ठीक करना है? *', 'How urgent?': 'कितना ज़रूरी?', 'Details *': 'विवरण *', 'Photo (optional)': 'फ़ोटो (वैकल्पिक)',
    'Document': 'दस्तावेज़', 'Added': 'जोड़ा गया', 'Total outstanding': 'कुल बकाया', 'Photos': 'फ़ोटो', 'Comment': 'टिप्पणी', 'Email for reminders': 'रिमाइंडर के लिए ईमेल',
    'No requests yet.': 'अभी कोई अनुरोध नहीं।', 'Nothing due right now.': 'अभी कुछ देय नहीं।', 'No payments recorded yet.': 'अभी कोई भुगतान दर्ज नहीं।',
    'No records yet': 'अभी कोई रिकॉर्ड नहीं', 'Properties': 'संपत्तियाँ',
    // simpler layout
    'Bills & payments': 'बिल और भुगतान', 'Repairs': 'मरम्मत', 'Settings': 'सेटिंग्स', 'More': 'और', 'More ▾': 'और ▾', 'Bank matching': 'बैंक मिलान',
    'Profile': 'प्रोफ़ाइल', 'Rooms occupied': 'भरे हुए कमरे', 'Collected this month': 'इस महीने वसूला गया', 'Still to collect': 'वसूली बाकी',
    'Show details': 'विवरण दिखाएँ', 'This month': 'इस महीने', 'Open bills (all months)': 'खुले बिल (सभी महीने)', 'Vacant rooms': 'खाली कमरे',
    'Expenses this month': 'इस महीने के खर्च', 'Open Finance →': 'वित्त खोलें →', 'More actions': 'और कार्य',
    'Every bill and payment in one place.': 'हर बिल और भुगतान एक जगह।',
    'Upload a bank statement. Nothing is recorded until you confirm.': 'बैंक स्टेटमेंट अपलोड करें। आपकी पुष्टि के बिना कुछ दर्ज नहीं होता।',
    'Agreements and end dates.': 'अनुबंध और समाप्ति तिथियाँ।', 'Nothing is sent until you approve.': 'आपकी मंज़ूरी के बिना कुछ नहीं भेजा जाता।',
    'Requests from tenants and your own tasks.': 'किरायेदारों के अनुरोध और आपके अपने काम।', 'Print or save any report as PDF.': 'कोई भी रिपोर्ट प्रिंट करें या PDF में सहेजें।',
    'Ask about your records. It only prepares things for you to approve.': 'अपने रिकॉर्ड के बारे में पूछें। यह केवल आपकी मंज़ूरी के लिए चीज़ें तैयार करता है।',
    'Trends, plus an estimate for next month.': 'रुझान, और अगले महीने का अनुमान।', 'New repair request': 'नया मरम्मत अनुरोध', 'No repair requests here.': 'यहाँ कोई मरम्मत अनुरोध नहीं।',
    'For your screens on this device.': 'इस डिवाइस पर आपकी स्क्रीन के लिए।', 'Online payments': 'ऑनलाइन भुगतान',
    'Preview mode:': 'पूर्वावलोकन मोड:', 'only in-app messages are really delivered.': 'केवल ऐप के अंदर के संदेश ही सच में पहुँचते हैं।',
    'Live:': 'चालू:', 'approved messages are sent.': 'मंज़ूर किए गए संदेश भेजे जाते हैं।',
    'Basic mode:': 'बेसिक मोड:', 'answers come from built-in rules.': 'जवाब पहले से तय नियमों से आते हैं।',
    'No buildings yet.': 'अभी कोई इमारत नहीं।',
    'You can turn on AI in Settings.': 'आप सेटिंग्स में AI चालू कर सकते हैं।', 'The owner can turn on AI in Settings.': 'मालिक सेटिंग्स में AI चालू कर सकते हैं।',
  };

  const KEY = 'rentLedgerLang';
  let lang = 'en';
  try { lang = localStorage.getItem(KEY) === 'hi' ? 'hi' : 'en'; } catch {}
  const ATTRS = ['placeholder', 'title', 'aria-label'];

  function t(text) { return lang === 'hi' && HI[text] ? HI[text] : text; }

  function translateNode(root) {
    if (lang !== 'hi' || !root) return;
    if (root.nodeType === Node.TEXT_NODE) return translateText(root);
    if (root.nodeType !== Node.ELEMENT_NODE) return;
    if (root.closest?.('[data-no-i18n], textarea, script, style')) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: (n) => (n.nodeType === Node.ELEMENT_NODE && (n.hasAttribute('data-no-i18n') || ['TEXTAREA', 'SCRIPT', 'STYLE'].includes(n.tagName)) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const nodes = [root];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const n of nodes) {
      if (n.nodeType === Node.TEXT_NODE) translateText(n);
      else for (const a of ATTRS) { const v = n.getAttribute?.(a); if (v && HI[v.trim()]) n.setAttribute(a, HI[v.trim()]); }
    }
  }
  function translateText(node) {
    const raw = node.nodeValue;
    const key = raw.trim();
    if (!key || !HI[key]) return;
    node.nodeValue = raw.replace(key, HI[key]);
  }

  const observer = new MutationObserver((mutations) => {
    if (lang !== 'hi') return;
    for (const m of mutations) m.addedNodes.forEach(translateNode);
  });

  function start() {
    document.documentElement.lang = lang;
    observer.observe(document.body, { childList: true, subtree: true });
    translateNode(document.body);
  }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);

  function setLanguage(next) {
    lang = next === 'hi' ? 'hi' : 'en';
    try { localStorage.setItem(KEY, lang); } catch {}
    document.documentElement.lang = lang;
  }

  function picker() {
    return `<div class="lang-picker" role="group" aria-label="Language" data-no-i18n><button type="button" data-lang-pick="en" aria-pressed="${lang === 'en'}">English</button><button type="button" data-lang-pick="hi" aria-pressed="${lang === 'hi'}">हिन्दी</button></div>`;
  }

  window.RL_I18N = { t, get lang() { return lang; }, setLanguage, picker, translate: translateNode, dictionary: HI };
})();
