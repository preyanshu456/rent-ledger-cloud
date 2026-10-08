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
    'Profile': 'प्रोफ़ाइल', 'Rooms occupied': 'भरे हुए कमरे', 'Collected this month': 'इस महीने वसूला गया', 'Received this month': 'इस महीने मिला', "This month's bills": 'इस महीने के बिल', 'Still to collect': 'वसूली बाकी',
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
    // phone speed update
    'Change floor rent or remove a floor': 'फ़्लोर का किराया बदलें या फ़्लोर हटाएँ', 'Floor rent': 'फ़्लोर का किराया', 'Done': 'हो गया', 'How it reads (example)': 'ऐसा दिखेगा (उदाहरण)', 'Prepare': 'तैयार करें', 'Verified': 'सत्यापित', 'Your account and security.': 'आपका खाता और सुरक्षा।', 'Gas bills to enter': 'दर्ज करने के लिए गैस बिल', 'Loading…': 'लोड हो रहा है…', 'A new floor rent applies to every room on that floor from now on. Past bills don\'t change.': 'नया फ़्लोर किराया अब से उस फ़्लोर के हर कमरे पर लागू होगा। पुराने बिल नहीं बदलेंगे।', 'No messages. Use “Prepare” to make reminders.': 'कोई संदेश नहीं। रिमाइंडर बनाने के लिए “तैयार करें” इस्तेमाल करें।',
    // finance: make bills
    'Make bills': 'बिल बनाएँ', 'Bills for what each room still owes': 'हर कमरे के बकाया का बिल', 'Floor': 'मंज़िल', 'All floors': 'सभी मंज़िलें', 'All rooms': 'सभी कमरे', 'Ground floor': 'भूतल', 'Include': 'शामिल करें', 'Other': 'अन्य', 'Tenants who moved out': 'जा चुके किरायेदार', 'bills selected': 'बिल चुने गए', 'to collect': 'वसूलना है', 'Download PDF': 'PDF डाउनलोड करें', 'PDF': 'PDF', 'Share': 'शेयर करें', 'To pay': 'देना है', 'after advance': 'अग्रिम घटाकर', 'No tenant': 'कोई किरायेदार नहीं', 'Owner’s floor': 'मालिक की मंज़िल', '(moved out)': '(जा चुके)', 'Nothing is pending for this choice.': 'इस चुनाव के लिए कुछ भी बकाया नहीं है।', 'Not included: tenants who moved out owe': 'शामिल नहीं: जा चुके किरायेदारों का बकाया', 'How to pay (printed on every bill)': 'भुगतान कैसे करें (हर बिल पर छपेगा)', 'How to pay (printed on bills)': 'भुगतान कैसे करें (बिलों पर छपेगा)', 'Not added yet. Add your UPI ID or bank details so tenants know how to pay.': 'अभी जोड़ा नहीं गया। अपनी UPI ID या बैंक विवरण जोड़ें ताकि किरायेदार जान सकें कि भुगतान कैसे करें।', 'Choose at least one type.': 'कम से कम एक प्रकार चुनें।', 'Tick at least one bill.': 'कम से कम एक बिल चुनें।', 'Saved. It will be printed on every bill.': 'सहेजा गया। यह हर बिल पर छपेगा।',
    'You can turn on AI in Settings.': 'आप सेटिंग्स में AI चालू कर सकते हैं।', 'The owner can turn on AI in Settings.': 'मालिक सेटिंग्स में AI चालू कर सकते हैं।',
    // more screens (October 2026)
    'HOME': 'घर', 'PROPERTY, SIMPLIFIED': 'संपत्ति, आसान तरीके से', 'A calmer way to manage every key.': 'हर चाबी को सँभालने का एक सुकून भरा तरीका।',
    'Keep rent, electricity, rooms and tenant records in one considered place.': 'किराया, बिजली, कमरे और किरायेदारों का रिकॉर्ड एक ही जगह पर रखें।',
    '◈ Owner command centre': '◈ मालिक का नियंत्रण केंद्र', '◌ Private tenant billing': '◌ किरायेदारों के निजी बिल', 'Made for modern rental homes': 'आज के किराये के घरों के लिए बना',
    'Your complete property workspace awaits.': 'आपकी पूरी संपत्ति का कामकाज यहाँ है।',
    'Open this page in Chrome or Edge, then use its Install app option.': 'यह पेज Chrome या Edge में खोलें, फिर उसका "ऐप इंस्टॉल करें" विकल्प चुनें।', 'CREATE ACCOUNT': 'खाता बनाएँ',
    'Join as a owner': 'मालिक के रूप में जुड़ें', 'Join as a tenant': 'किरायेदार के रूप में जुड़ें', 'Create your private owner workspace.': 'अपना निजी मालिक खाता बनाएँ।', 'Setup code': 'सेटअप कोड',
    '(only if your server asks for one)': '(सिर्फ़ तब, जब सर्वर माँगे)', 'Your name': 'आपका नाम', 'At least 8 characters': 'कम से कम 8 अक्षर', 'PASSWORD RESET': 'पासवर्ड रीसेट',
    'Get a one-time code': 'एक बार का कोड पाएँ',
    'Enter the mobile number or email used for your account. We will send a 6-digit verification code.': 'अपने खाते का मोबाइल नंबर या ईमेल डालें। हम 6 अंकों का सत्यापन कोड भेजेंगे।',
    'Sections': 'हिस्से', 'Reference (UTR / cheque no.)': 'संदर्भ (UTR / चेक नंबर)',
    'Apply to the oldest unpaid bills automatically (anything extra is kept as credit)': 'सबसे पुराने बकाया बिलों में अपने आप जोड़ें (बचा हुआ पैसा क्रेडिट में रहेगा)', 'Cash': 'नकद', 'Upi': 'UPI',
    'UPI': 'UPI', 'Bank transfer': 'बैंक ट्रांसफ़र', 'Cheque': 'चेक', 'Rent overdue': 'किराया बकाया', 'in-app': 'ऐप में', 'In-app': 'ऐप में',
    'Can’t reach: no login and no consent for email/SMS/WhatsApp': 'संपर्क नहीं हो सकता: न लॉगिन है, न ईमेल/SMS/WhatsApp की सहमति', 'Rent due soon': 'किराया जल्द देय', 'Rent due today': 'किराया आज देय',
    'Lease ending': 'लीज़ ख़त्म हो रही है', 'Payment received': 'भुगतान मिला', 'Maintenance update': 'मरम्मत की जानकारी', 'In-app: on': 'ऐप में: चालू', 'In-app: off': 'ऐप में: बंद',
    'Email: not set up': 'ईमेल: सेट नहीं', 'Sms: not set up': 'SMS: सेट नहीं', 'Whatsapp: not set up': 'WhatsApp: सेट नहीं', 'Email: on': 'ईमेल: चालू', 'Email: off': 'ईमेल: बंद',
    'Email: preview only': 'ईमेल: सिर्फ़ पूर्वावलोकन', 'Sms: on': 'SMS: चालू', 'Sms: off': 'SMS: बंद', 'Sms: preview only': 'SMS: सिर्फ़ पूर्वावलोकन', 'Whatsapp: on': 'WhatsApp: चालू',
    'Whatsapp: off': 'WhatsApp: बंद', 'Whatsapp: preview only': 'WhatsApp: सिर्फ़ पूर्वावलोकन',
    'Preview mode: email, SMS and WhatsApp messages are marked “simulated” and are not actually sent.': 'पूर्वावलोकन मोड: ईमेल, SMS और WhatsApp संदेश “नकली” के रूप में दर्ज होते हैं और सच में नहीं भेजे जाते।',
    'Prepare reminders automatically every day': 'हर दिन अपने आप रिमाइंडर तैयार करें', 'Wait for my approval before sending (recommended)': 'भेजने से पहले मेरी मंज़ूरी का इंतज़ार करें (सुझाया गया)',
    'Remind on the due date': 'देय तिथि पर याद दिलाएँ', 'Days before due date': 'देय तिथि से पहले के दिन', 'Overdue reminder every (days)': 'बकाया रिमाइंडर हर (दिन)',
    'Maximum overdue reminders': 'अधिकतम बकाया रिमाइंडर', 'Lease ending reminders (days before, comma separated)': 'लीज़ ख़त्म होने के रिमाइंडर (कितने दिन पहले, कॉमा से अलग)', 'Email': 'ईमेल',
    'Sms': 'SMS', 'Whatsapp': 'WhatsApp',
    'Tenants only get email, SMS or WhatsApp if they have agreed to it (set on the tenant’s record or in their portal). In-app messages need a tenant login.': 'किरायेदारों को ईमेल, SMS या WhatsApp तभी मिलते हैं जब उन्होंने सहमति दी हो (किरायेदार के रिकॉर्ड या उनके पोर्टल में)। ऐप के संदेशों के लिए किरायेदार का लॉगिन ज़रूरी है।',
    'Name': 'नाम', 'Time zone': 'समय क्षेत्र', 'Default language for tenants': 'किरायेदारों की डिफ़ॉल्ट भाषा', 'Receipt footer': 'रसीद के नीचे का संदेश',
    'Anonymise former tenants after (days, 0 = never)': 'पुराने किरायेदारों की पहचान हटाएँ (दिन बाद, 0 = कभी नहीं)', 'Use the AI model for the assistant': 'सहायक के लिए AI मॉडल इस्तेमाल करें',
    'No AI provider is set up on the server, so the assistant uses basic mode. When AI is on, your questions and the figures it looks up are sent to the provider. Phone numbers, emails, ID numbers and documents are never sent.': 'सर्वर पर कोई AI सेवा सेट नहीं है, इसलिए सहायक बेसिक मोड में चलता है। AI चालू होने पर आपके सवाल और उनसे जुड़े आँकड़े सेवा को भेजे जाते हैं। फ़ोन नंबर, ईमेल, पहचान नंबर और दस्तावेज़ कभी नहीं भेजे जाते।',
    'this device': 'यह डिवाइस',
    'Choose a colour theme. It changes the whole app on this device and is remembered next time.': 'रंग की थीम चुनें। इससे इस डिवाइस पर पूरा ऐप बदल जाता है और अगली बार भी याद रहता है।', 'Indigo': 'नील',
    'Teal': 'हरा-नीला', 'Ocean': 'समुद्री', 'Forest': 'वन', 'Plum': 'बैंगनी', 'Graphite': 'ग्रेफ़ाइट',
    'Tenants can’t pay online yet. To show a Pay button on their bills, add your Razorpay keys (RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET) to the server settings in Railway.': 'किरायेदार अभी ऑनलाइन भुगतान नहीं कर सकते। उनके बिलों पर "भुगतान करें" बटन दिखाने के लिए Railway में सर्वर सेटिंग्स में अपनी Razorpay कुंजियाँ (RAZORPAY_KEY_ID और RAZORPAY_KEY_SECRET) जोड़ें।',
    'e.g. Thank you!': 'जैसे: धन्यवाद!', 'Colour theme': 'रंग की थीम', 'Contact': 'संपर्क', 'Role': 'भूमिका', 'Since': 'कब से', 'No pending invites.': 'कोई लंबित आमंत्रण नहीं।',
    'Invite a property manager': 'प्रॉपर्टी मैनेजर को आमंत्रित करें', 'Name *': 'नाम *', 'Their mobile or email *': 'उनका मोबाइल या ईमेल *',
    'Managers can run day-to-day work (tenants, bills, payments, maintenance, reminders, reports) but can’t reverse payments, void or waive bills, settle deposits, manage the team, export data or see the audit log.': 'मैनेजर रोज़ का काम (किरायेदार, बिल, भुगतान, मरम्मत, रिमाइंडर, रिपोर्ट) कर सकते हैं, लेकिन भुगतान वापस लेना, बिल रद्द या माफ़ करना, जमा राशि निपटाना, टीम सँभालना, डेटा निकालना या ऑडिट लॉग देखना नहीं कर सकते।',
    'latest 200': 'आख़िरी 200', 'When': 'कब', 'Who': 'किसने', 'Action': 'काम',
    'The server keeps automatic database backups (at every start-up and once a day). You can also make one now, or download all your records.': 'सर्वर अपने आप डेटाबेस का बैकअप रखता है (हर बार शुरू होने पर और दिन में एक बार)। आप अभी भी एक बना सकते हैं, या अपने सारे रिकॉर्ड डाउनलोड कर सकते हैं।',
    'Download all records (JSON)': 'सारे रिकॉर्ड डाउनलोड करें (JSON)', 'Backup': 'बैकअप', 'Time': 'समय',
    'The download contains tenants’ personal details. Keep it private. Uploaded documents are not included.': 'डाउनलोड में किरायेदारों की निजी जानकारी है। इसे निजी रखें। अपलोड किए गए दस्तावेज़ शामिल नहीं हैं।',
    'Outstanding now': 'अभी बकाया',
    'Billed and collected use bills dated in the selected months; received and expenses use payment and expense dates; outstanding and overdue are all open bills as of today.': 'बिल और वसूली चुने गए महीनों के बिलों से; मिला पैसा और खर्च भुगतान और खर्च की तारीख़ से; बकाया और देरी वाले आज तक के सभी खुले बिल हैं।',
    'What to include': 'क्या शामिल करें', 'Active': 'चालू', 'Draft': 'मसौदा', 'Ended': 'ख़त्म', 'Terminated': 'समाप्त किया गया',
    'No leases yet. Tenants without a lease are billed from the Rent tab as before.': 'अभी कोई लीज़ नहीं। जिन किरायेदारों की लीज़ नहीं है, उनका बिल पहले की तरह किराया टैब से बनता है।',
    'Read fields from the agreement (PDF)': 'एग्रीमेंट (PDF) से जानकारी पढ़ें', '…or paste its text': '…या उसका टेक्स्ट चिपकाएँ', 'Due day of month (1-28)': 'महीने की देय तारीख़ (1-28)',
    'Notice period (days)': 'नोटिस अवधि (दिन)', 'Create rent bills automatically each period': 'हर अवधि में अपने आप किराये के बिल बनाएँ', 'Terms / notes': 'शर्तें / टिप्पणी',
    'No expenses recorded for these filters.': 'इन फ़िल्टर के लिए कोई खर्च दर्ज नहीं।',
    'Amounts can’t be edited after saving; void a wrong entry and add the correct one. Voided entries stay in the audit log.': 'सहेजने के बाद राशि बदली नहीं जा सकती; ग़लत एंट्री रद्द करें और सही एंट्री जोड़ें। रद्द एंट्री ऑडिट लॉग में रहती हैं।',
    'Receipt (optional)': 'रसीद (वैकल्पिक)', 'Statement CSV file': 'स्टेटमेंट की CSV फ़ाइल', '…or paste the CSV': '…या CSV चिपकाएँ', 'Import': 'इंपोर्ट करें',
    'Only money coming in is imported. Lines already imported are skipped automatically.': 'सिर्फ़ आने वाला पैसा इंपोर्ट होता है। पहले से इंपोर्ट की गई लाइनें अपने आप छोड़ दी जाती हैं।',
    'To match': 'मिलान बाकी', 'Matched': 'मिलान हुआ', 'Ignored': 'अनदेखा', 'No credits waiting to be matched.': 'मिलान के लिए कोई जमा बाकी नहीं।', 'Nothing here.': 'यहाँ कुछ नहीं।',
    'Leave the months empty for the last 12 months.': 'पिछले 12 महीनों के लिए महीने ख़ाली छोड़ दें।', 'Rent collection': 'किराया वसूली',
    'Rent billed and collected per room and month.': 'हर कमरे और महीने का बिल और वसूली।', 'Outstanding dues': 'बकाया राशि',
    'Every unpaid bill today, oldest first.': 'आज तक के सभी बकाया बिल, सबसे पुराने पहले।', 'Payments received': 'मिले भुगतान',
    'All money received in the period, by method.': 'इस अवधि में मिला सारा पैसा, तरीके के अनुसार।', 'Property income & expenses': 'संपत्ति की आय और खर्च',
    'Billed, received, expenses and net per property.': 'हर संपत्ति का बिल, मिला पैसा, खर्च और शुद्ध।', 'Monthly cash flow': 'मासिक नकदी प्रवाह',
    'Money in and out, month by month.': 'हर महीने आया और गया पैसा।', 'Lease expiries': 'लीज़ की समाप्ति', 'Active leases and when they end.': 'चालू लीज़ और वे कब ख़त्म होंगी।',
    'Expenses (incl. maintenance)': 'खर्च (मरम्मत सहित)', 'Every expense in the period.': 'इस अवधि का हर खर्च।', 'Deposits & settlements': 'जमा राशि और निपटारे',
    'Deposits held, deductions and refunds.': 'रखी गई जमा राशि, कटौती और वापसी।', 'Avg. monthly expenses': 'औसत मासिक खर्च', 'Rate': 'दर', 'estimate': 'अनुमान',
    'Net after typical expenses': 'सामान्य खर्च के बाद शुद्ध', 'Collection trend:': 'वसूली का रुझान:', 'not enough history': 'पर्याप्त इतिहास नहीं', 'possible shortfall': 'संभावित कमी',
    'falling': 'घट रहा', 'rising': 'बढ़ रहा', 'steady': 'स्थिर',
    'Expected rent = active leases billing next month + occupied rooms without a lease at their monthly rent.': 'अनुमानित किराया = अगले महीने बिल बनने वाली चालू लीज़ + बिना लीज़ वाले भरे कमरे उनके मासिक किराये पर।',
    'Vacancies, new tenants and one-off costs are not predicted.': 'ख़ाली कमरे, नए किरायेदार और एक बार के खर्च का अनुमान नहीं लगाया जाता।', 'Nothing unusual found.': 'कुछ असामान्य नहीं मिला।',
    'These are prompts to review, not conclusions. Many have ordinary explanations.': 'ये जाँचने के संकेत हैं, निष्कर्ष नहीं। कई की सामान्य वजह होती है।',
    'Ask a question to get started.': 'शुरू करने के लिए एक सवाल पूछें।', 'Who is overdue?': 'किसका भुगतान देर से है?', 'Who hasn’t paid this month?': 'इस महीने किसने भुगतान नहीं किया?',
    'Leases expiring in 60 days': '60 दिनों में ख़त्म होने वाली लीज़', 'Draft reminders for overdue tenants': 'देर वाले किरायेदारों के लिए रिमाइंडर तैयार करें',
    'e.g. Which tenants haven\'t paid this month?': 'जैसे: इस महीने किन किरायेदारों ने भुगतान नहीं किया?', 'Sign-in contact': 'साइन-इन संपर्क', 'Account type': 'खाते का प्रकार',
    'Member since': 'सदस्य कब से', 'For your security, passwords are never displayed. You can update yours at any time.': 'आपकी सुरक्षा के लिए पासवर्ड कभी दिखाए नहीं जाते। आप इसे कभी भी बदल सकते हैं।',
    'Current password': 'मौजूदा पासवर्ड', 'Confirm new password': 'नए पासवर्ड की पुष्टि करें', 'Update password': 'पासवर्ड बदलें', '← All buildings': '← सभी इमारतें',
    'Total rent collected': 'कुल वसूला गया किराया', 'Rent billed': 'किराये का बिल', 'Floors & rooms': 'मंज़िलें और कमरे', '+ Add room': '+ कमरा जोड़ें', '+ Add owner floor': '+ मालिक की मंज़िल जोड़ें',
    'Building details': 'इमारत की जानकारी', 'Building name': 'इमारत का नाम', 'Address': 'पता', 'Total floors': 'कुल मंज़िलें', 'Save changes': 'बदलाव सहेजें', 'Delete building': 'इमारत हटाएँ',
    'Add a floor / room': 'मंज़िल / कमरा जोड़ें', 'Floor number *': 'मंज़िल नंबर *', 'Room / unit label *': 'कमरा / यूनिट का नाम *', 'Monthly rent (₹)': 'मासिक किराया (₹)', 'Save room': 'कमरा सहेजें',
    'e.g. 1A or Room 3': 'जैसे: 1A या कमरा 3', 'Optional': 'वैकल्पिक', 'Update rent': 'किराया बदलें', 'Mobile': 'मोबाइल', '+ Add entry': '+ एंट्री जोड़ें', 'Paid on': 'भुगतान की तारीख़',
    'Mark paid': 'भुगतान हुआ', 'Add rent entry': 'किराये की एंट्री जोड़ें', 'Month *': 'महीना *', 'Year *': 'साल *', 'Rent amount (₹) *': 'किराये की राशि (₹) *',
    'Amount paid (₹)': 'भुगतान की गई राशि (₹)', 'Paid date': 'भुगतान की तारीख़', 'Save entry': 'एंट्री सहेजें', 'Electricity history': 'बिजली का इतिहास', '+ Add reading': '+ रीडिंग जोड़ें',
    'Prev.': 'पिछली', 'Current': 'मौजूदा', 'Units': 'यूनिट', 'Add electricity entry': 'बिजली की एंट्री जोड़ें', 'Rate per unit (₹)': 'प्रति यूनिट दर (₹)', 'Previous reading': 'पिछली रीडिंग',
    'Current reading *': 'मौजूदा रीडिंग *', 'Gas meter & billing authority': 'गैस मीटर और बिलिंग संस्था',
    'Link this room to a gas meter ID and a billing authority (gas board, LPG/PNG supplier, etc.) before adding gas bills.': 'गैस बिल जोड़ने से पहले इस कमरे को गैस मीटर ID और बिलिंग संस्था (गैस बोर्ड, LPG/PNG सप्लायर आदि) से जोड़ें।',
    'Meter ID *': 'मीटर ID *', 'Billing authority *': 'बिलिंग संस्था *', 'Link meter': 'मीटर जोड़ें', 'Gas history': 'गैस का इतिहास', '+ Add bill': '+ बिल जोड़ें',
    'No gas entries yet.': 'अभी गैस की कोई एंट्री नहीं।', 'Consumer / BP number on the gas bill': 'गैस बिल पर उपभोक्ता / BP नंबर', 'e.g. Indraprastha Gas Limited': 'जैसे: इंद्रप्रस्थ गैस लिमिटेड',
    'Link a gas meter first': 'पहले गैस मीटर जोड़ें', 'View your rent and electricity bill in one place.': 'अपना किराया और बिजली का बिल एक ही जगह देखें।',
    "Download a copy of all your records (buildings, tenants and every bill). Receipt images are not included. Keep the file somewhere private, because it contains tenants' personal details. The server also keeps automatic daily backups.": 'अपने सारे रिकॉर्ड (इमारतें, किरायेदार और हर बिल) की एक कॉपी डाउनलोड करें। रसीद की तस्वीरें शामिल नहीं हैं। फ़ाइल को किसी निजी जगह रखें, क्योंकि इसमें किरायेदारों की निजी जानकारी है। सर्वर भी हर दिन अपने आप बैकअप रखता है।',
    // Rent in instalments
    'How you record rent': 'आप किराया कैसे दर्ज करते हैं', 'Simple: mark paid or set the amount paid': 'सरल: भुगतान हुआ चिह्नित करें या भुगतान की रकम लिखें',
    'Instalments: set the total, then add each amount received': 'किस्तें: कुल रकम तय करें, फिर हर मिली रकम जोड़ें',
    'Add rent for a month': 'किसी महीने का किराया जोड़ें', 'Total rent (₹) *': 'कुल किराया (₹) *', 'Received now (₹)': 'अभी मिला (₹)', 'Received on': 'मिलने की तारीख',
    'Rent received': 'मिला किराया', '+ Add month': '+ महीना जोड़ें', 'Total rent': 'कुल किराया', 'Received': 'मिला', 'Remaining': 'बाकी',
    '+ Add amount received': '+ मिली रकम जोड़ें', 'Amount received (₹) *': 'मिली रकम (₹) *', 'Add amount': 'रकम जोड़ें', 'Amount added': 'रकम जोड़ दी गई',
    'Nothing received yet.': 'अभी कुछ नहीं मिला।', 'Reference / note': 'संदर्भ / नोट', 'UTR, cheque no. (optional)': 'UTR, चेक नंबर (वैकल्पिक)',
    'Instalments: set the total rent, then add each amount as you receive it.': 'किस्तें: कुल किराया तय करें, फिर जैसे-जैसे पैसा मिले, हर रकम जोड़ें।',
    'Amounts received are added one by one with “Add amount received”.': 'मिली रकम “मिली रकम जोड़ें” से एक-एक करके जोड़ी जाती है।',
    // Settings → Online payments (each owner's own Razorpay account)
    'Connected': 'जुड़ा हुआ', 'Disconnect': 'हटाएँ', 'Copy': 'कॉपी करें', 'Live': 'लाइव', 'Test mode': 'टेस्ट मोड',
    'Get paid straight to your bank': 'पैसा सीधे अपने बैंक खाते में पाएँ', 'Connect Razorpay': 'Razorpay जोड़ें', 'Replace keys': 'कुंजियाँ बदलें',
    'Key ID *': 'Key ID *', 'Key Secret *': 'Key Secret *', 'Webhook secret (optional)': 'Webhook secret (वैकल्पिक)', 'Check and save': 'जाँचें और सहेजें',
    'Leave empty to keep the saved one': 'सहेजा हुआ रखने के लिए खाली छोड़ें', 'Webhook backup (recommended)': 'Webhook बैकअप (सुझाया गया)',
    'Set up online payments': 'ऑनलाइन भुगतान सेट करें',
    'The Key Secret is stored encrypted and is never shown again or sent to any browser.': 'Key Secret एन्क्रिप्ट करके रखा जाता है, और न दोबारा दिखाया जाता है, न किसी ब्राउज़र को भेजा जाता है।',
    'Tenants can’t pay online yet. Connect your own Razorpay account so their payments go straight to your bank account.': 'किरायेदार अभी ऑनलाइन भुगतान नहीं कर सकते। अपना Razorpay खाता जोड़ें, ताकि उनका भुगतान सीधे आपके बैंक खाते में आए।',
    'Razorpay connected. Tenants can now pay online.': 'Razorpay जुड़ गया। अब किरायेदार ऑनलाइन भुगतान कर सकते हैं।', 'Razorpay disconnected': 'Razorpay हटा दिया गया',
    'Use live keys?': 'लाइव कुंजियाँ इस्तेमाल करें?', 'Use live keys': 'लाइव कुंजियाँ इस्तेमाल करें', 'Tenants will pay real money into this Razorpay account.': 'किरायेदार इस Razorpay खाते में असली पैसा भरेंगे।',
    'Disconnect Razorpay?': 'Razorpay हटाएँ?', 'Tenants will no longer see the Pay button until you connect an account again.': 'जब तक आप फिर से खाता नहीं जोड़ते, किरायेदारों को भुगतान बटन नहीं दिखेगा।',
    'Copied': 'कॉपी हो गया',
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
  // Text with numbers or dates in it ("Floor 2", "Rent Oct 2026").
  const MONTHS_HI = { Jan: 'जन', Feb: 'फ़र', Mar: 'मार्च', Apr: 'अप्रैल', May: 'मई', Jun: 'जून', Jul: 'जुलाई', Aug: 'अग', Sep: 'सित', Oct: 'अक्टू', Nov: 'नव', Dec: 'दिस' };
  const M = '(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)';
  const PATTERNS = [
    [new RegExp(`^${M} (\\d{4})$`), (m, mo, y) => `${MONTHS_HI[mo]} ${y}`],
    [new RegExp(`^(Rent|Electricity|Gas) ${M} (\\d{4})$`), (m, k, mo, y) => `${HI[k] || k} ${MONTHS_HI[mo]} ${y}`],
    [new RegExp(`^Edit rent entry · ${M} (\\d{4})$`), (m, mo, y) => `किराये की एंट्री बदलें · ${MONTHS_HI[mo]} ${y}`],
    [/^Floor (\d+)$/, (m, n) => `मंज़िल ${n}`],
    [/^Delete floor (\d+)…$/, (m, n) => `मंज़िल ${n} हटाएँ…`],
    [/^Floor (\d+) · (₹[\d,.]+)\/mo rent · (₹[\d,.]+) deposit$/, (m, n, r, d) => `मंज़िल ${n} · ${r}/माह किराया · ${d} जमा`],
    [/^Forecast for (\d{4}-\d{2})$/, (m, ym) => `${ym} का अनुमान`],
    [/^Collection follows the last (\d+) month\(s\) average of (\d+)%\.$/, (m, n, pct) => `वसूली पिछले ${n} महीने के औसत ${pct}% के हिसाब से मानी गई है।`],
    [/^Expenses follow the last (\d+) months' average \((.+)\)\.$/, (m, n, amt) => `खर्च पिछले ${n} महीनों के औसत (${amt}) के हिसाब से माना गया है।`],
  ];
  function translateText(node) {
    const raw = node.nodeValue;
    const key = raw.trim();
    if (!key) return;
    if (HI[key]) { node.nodeValue = raw.replace(key, HI[key]); return; }
    if (!/\d/.test(key)) return;
    for (const [re, fn] of PATTERNS) {
      if (re.test(key)) { node.nodeValue = raw.replace(key, key.replace(re, fn)); return; }
    }
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
