# Medhini Ayurveda Appointment Desk

This version uses a small Node.js backend server with a MySQL database.

## What it does

- Two company data inputter logins: Kusal and Maneesha.
- Color-coded appointments by inputter and treatment type.
- Treatment days are Sunday, Wednesday, Thursday, and Saturday.
- The first selected date is today when today is a treatment day, otherwise the next treatment day.
- The top row shows the next 6 treatment days.
- The calendar can select any future date.
- Appointments store name, phone number, treatment type, time, length, note, payment status, and appointment status.
- Reminder text can be copied, sent by SMS, opened in WhatsApp, or saved as a phone contact.
- Data is saved in MySQL.
- Export and import buttons are included for backups.

## Setup

1. Install Node.js and MySQL.
2. Copy `.env.example` to `.env` and enter your MySQL username and password.
3. Run `npm.cmd install` on Windows PowerShell, or `npm install` in another terminal.
4. Run `npm.cmd start` on Windows PowerShell, or `npm start` in another terminal.
5. Open `http://localhost:3000` in Chrome.

The server creates the `appointments` table automatically when it starts.

## Login

Use `Kusal` or `Maneesha`. No password is required.

## Phone use

For iPhone Chrome, open the server address from the phone. If the backend runs on a computer in the same Wi-Fi network, use that computer's local network IP address, for example `http://192.168.1.10:3000`.
