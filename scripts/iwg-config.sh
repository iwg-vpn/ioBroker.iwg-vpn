#!/bin/bash

function isRoot() {
	if [ "${EUID}" -ne 0 ]; then
		echo "You need to run this script as root"
		exit 1
	fi
}

function updateSudoers() {
	echo ""
	echo "This script will grant permissions to ioBroker to manage WireGuard now."
	read -n1 -r -p "Press any key to continue..."

    if [[ -e /etc/sudoers.d/iobroker ]]; then
        WG_QUICK=$(which wg-quick)
        WG=$(which wg)
        echo "iobroker ALL=(ALL) NOPASSWD: ${WG_QUICK}
iobroker ALL=(ALL) NOPASSWD: ${WG}" > /etc/sudoers.d/iobroker_iwg

    	echo "Permissions were granted."

    else
		echo "Sudoers location is not found."
		exit 1
    fi
}

function removeSudoers() {
    rm -f /etc/sudoers.d/iobroker_iwg
	echo "Permissions were removed."

}

function initialCheck() {
	isRoot
}

function mngmn() {
	echo "It looks like required permissions were already granted to iobroker user."
	echo ""
	echo "What do you want to do?"
	echo "   (1) Remove permissions"
	echo "   (2) Exit"
	until [[ ${MENU_OPTION} =~ ^[1-2]$ ]]; do
		read -rp "Select an option [1-2]: " MENU_OPTION
	done
	case "${MENU_OPTION}" in
	1)
		removeSudoers
		;;
	2)
		exit 0
		;;
	esac
}

initialCheck

# Check if sudoers is already added
if [[ -e /etc/sudoers.d/iobroker_iwg ]]; then
	mngmn
else
	updateSudoers
fi
