use std::sync::atomic::{AtomicBool, Ordering};

static IS_RU: AtomicBool = AtomicBool::new(false);

pub fn set_main_language(lang: &str) {
    IS_RU.store(lang == "ru", Ordering::Relaxed);
}

pub fn is_ru() -> bool {
    IS_RU.load(Ordering::Relaxed)
}

pub fn tr<'a>(en: &'a str, ru: &'a str) -> &'a str {
    if is_ru() {
        ru
    } else {
        en
    }
}

pub fn tr_string(en: String, ru: String) -> String {
    if is_ru() {
        ru
    } else {
        en
    }
}
