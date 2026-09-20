plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}
fun publicSetting(key: String) = providers.gradleProperty(key).orElse("").get()
fun literal(value: String) = "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
android {
    namespace = "com.pantry.app"
    compileSdk = 36
    defaultConfig {
        applicationId = providers.gradleProperty("PLAY_PACKAGE_NAME").orElse("com.pantry.app").get()
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "1.1.0"
        for (key in listOf("BILLING_API_URL", "FIREBASE_PROJECT_ID", "FIREBASE_APP_ID", "FIREBASE_API_KEY")) {
            buildConfigField("String", key, literal(publicSetting(key)))
        }
    }
    buildFeatures { buildConfig = true }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/pantryAssets"))
    buildTypes { getByName("release") { isMinifyEnabled = false } }
}
val syncWebAssets by tasks.registering(Copy::class) {
    from(rootProject.projectDir.resolve("../public"))
    into(layout.buildDirectory.dir("generated/pantryAssets"))
}
tasks.named("preBuild").configure { dependsOn(syncWebAssets) }
dependencies {
    implementation("com.android.billingclient:billing:9.1.0")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation(platform("com.google.firebase:firebase-bom:34.19.0"))
    implementation("com.google.firebase:firebase-auth")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-play-services:1.10.2")
}
