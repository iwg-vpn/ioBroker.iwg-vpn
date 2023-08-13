import{u as o,_ as s,o as d,c as l,a as e,b as n,d as i,w as t,V as u,e as h,f as c}from"./index-36e2b4d3.js";const m={setup(){return{appStore:o()}},methods:{openAccountDialog(){this.appStore.toggleShowAccountDialog()}}};const p={class:"about"},g=h('<h1>Was kann der Adapter ioBroker.iwg-vpn?</h1><h3> Der Adapter stellt einen alternativen Kommunikationskanal zur Übermittlung der <li>Alexa-Kommandos an die Geräte im lokalen Netzwerk</li><li>Änderungen der Gerätezustände an Alexa Service</li> bereit. </h3><h1>Ist der Kommunikationskanal sicher?</h1><h3> Die Kommunikation wird vom <a href="https://www.wireguard.com/">Wireguard</a> abgewickelt und ist asymmetrisch verschlüsselt. Das Schlüsselpaar wird local auf dem ioBroker-Host generiert und der private Schlüssel wird niemals preisgegeben. Die Schlüsseln können jederzeit von Dir rotiert werden indem Du die vorhandenen Schlüsseln einfach löschst. </h3><h1>Was muss ich auf meinem ioBroker-Host installieren, um den Adapter benutzen zu können?</h1><h3> Da die Kommunikation vom Wireguard abgewickelt wird, muss der Wireguard installiert werden. <a href="https://htmlpreview.github.io/?https://github.com/iwg-vpn/iobroker.iwg-vpn/blob/main/howto/read-me.html">Hier</a> findest Du die How-To Anweisungen des Adapters. </h3><h1>Wie kann ich meine Alexa Geräte konfiguriren?</h1><h3> Der Adapter stellt keine Mitteln zur Konfiguration bereit. Stattdessen wird die vorhandene Konfiguration, die Du entweder manuell oder mit Hilfe von anderen Adaptern (ioBroker.iot, ioBroker.devices, usw.) bereits gemacht hast, einfach übernommen. Du findest die selben Geräte mit den selben Namen und Eigenschaften in der Alexa-App wieder. </h3><h1>Wie findet Alexa meine Geräte, wenn ich ioBroker.iwg-vpn benutze?</h1><h3> Damit Alexa die konfigurierten Geräte findet, muss Du den <a href="https://www.amazon.de/Standard-Benutzer-iwg-vpn/dp/B0B2PHFX13">ioBroker.iwg-vpn Alexa Skill</a> in deiner Alexa-App hinzufügen und mit Deinem Account verbinden. </h3><h1>Warum brauche ich einen Account zur Einbindung des ioBroker.iwg-vpn Skills in der Alexa-App?</h1><h3> Da viele Benutzer gleichzeitig den ioBroker.iwg-vpn Skill verwenden, muss der Skill die Kommandos verschiedener Benutzer unterscheiden können. Dafür dient der ioBroker.iwg-vpn Account. </h3><h1>Wie lege ich einen Account zur Einbindung des ioBroker.iwg-vpn Skills in der Alexa-App an?</h1>',13),k=e("h1",null,"Welche Daten muss ich zur Erstellung meines ioBroker.iwg-vpn Accounts eingeben?",-1),w=e("h3",null,"Keine. Es wird ein virtueller Account mit einer virtuellen E-Mail Adresse generiert. Du brauchst keine Daten preiszugeben.",-1),x=e("h1",null,"Warum sollte ich den ioBroker.iwg-vpn Adapter statt ioBroker.iot Adapter verwenden?",-1),A=e("h3",null,"Der Adapter hat keine Limits an die Anzahl der Alexa-Kommandos und ist kostenfrei.",-1);function v(r,f,_,b,D,a){return d(),l("div",p,[g,e("h3",null,[n("Ein eindeutiges Account wird für Dich automatisch angelegt indem Du auf "),i(u,{onClick:a.openAccountDialog},{default:t(()=>[i(c,{class:"green"},{default:t(()=>[n("mdi-link-variant")]),_:1})]),_:1},8,["onClick"]),n(" klickst. ")]),k,w,x,A])}const z=s(m,[["render",v]]);export{z as default};